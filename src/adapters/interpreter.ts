/**
 * Declarative Interpreter Engine (Phase 6)
 * Strictly bounded & non-Turing complete runtime for executing signed CMS adapter recipes.
 * AGENTS.md Rules:
 * Rule 2: Never use eval, new Function, remote JavaScript, dynamic remote imports, or arbitrary remote expressions.
 * Rule 8: Page-world code may execute only predefined adapter action IDs/recipes—never arbitrary remote URL/method/body instructions.
 * Rule 10: An appointment is not confirmed until the CMS write is read back and verified.
 */

import { type AdapterManifest, type DeclarativeRecipe } from './schema.js';
import {
  applyTransform,
  extractField,
  interpolatePath,
  assertPreconditions,
  executeWriteVerification,
  type WriteReceipt,
} from './primitives/index.js';
import { executePackagedHook } from './packaged-hooks/index.js';
import { ConflictError } from '../core/errors.js';

export type RecipeExecutionStatus = 'SUCCESS' | 'CONFLICT' | 'RATE_LIMITED' | 'ERROR';

export interface ExecuteRecipeOptions {
  manifest: AdapterManifest;
  recipeId: string;
  params?: Record<string, unknown>;
  baseOrigin?: string;
  fetchFn?: typeof fetch;
  document?: Document;
  cookieString?: string;
}

export interface RecipeExecutionResult {
  recipeId: string;
  status: RecipeExecutionStatus;
  data?: unknown;
  writeReceipt?: WriteReceipt;
  error?: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}

/**
 * Builds request payload body based on a declarative body template or sanitized input params.
 */
export function buildRequestBody(
  template: Record<string, unknown> | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (!template) {
    return { ...params };
  }

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(template)) {
    if (typeof val === 'string' && val.startsWith('$params.')) {
      const paramKey = val.slice('$params.'.length);
      result[key] = extractField(params, paramKey);
    } else {
      result[key] = val;
    }
  }
  return result;
}

/**
 * Executes a declarative recipe from a validated adapter manifest.
 */
export async function executeRecipe(options: ExecuteRecipeOptions): Promise<RecipeExecutionResult> {
  const { manifest, recipeId, document, cookieString } = options;
  const baseOrigin = options.baseOrigin || manifest.targetOrigin;
  const fetchFn = options.fetchFn || (typeof fetch !== 'undefined' ? fetch : undefined);

  if (!fetchFn) {
    return {
      recipeId,
      status: 'ERROR',
      error: { code: 'FETCH_UNAVAILABLE', message: 'fetch is not available in current execution context' },
    };
  }

  const recipe: DeclarativeRecipe | undefined = manifest.recipes?.[recipeId];
  if (!recipe) {
    return {
      recipeId,
      status: 'ERROR',
      error: {
        code: 'UNSUPPORTED_RECIPE_ID',
        message: `Recipe '${recipeId}' is not defined in adapter '${manifest.adapterId}'`,
      },
    };
  }

  // Verify capability is declared in manifest
  if (!manifest.capabilities.includes(recipe.capability)) {
    return {
      recipeId,
      status: 'ERROR',
      error: {
        code: 'MISSING_CAPABILITY',
        message: `Adapter lacks declared capability '${recipe.capability}' required by recipe '${recipeId}'`,
      },
    };
  }

  // 1. Prepare and transform parameters
  const params: Record<string, unknown> = { ...(options.params || {}) };
  if (recipe.transforms) {
    for (const item of recipe.transforms) {
      if (params[item.field] !== undefined) {
        try {
          params[item.field] = applyTransform(item.transform, params[item.field]);
        } catch (err) {
          return {
            recipeId,
            status: 'ERROR',
            error: {
              code: 'TRANSFORM_FAILED',
              message: (err as Error).message || `Transform '${item.transform}' failed on field '${item.field}'`,
            },
          };
        }
      }
    }
  }

  // 2. Execute packaged hook if specified
  const requestHeaders: Record<string, string> = { ...(recipe.headers || {}) };
  if (recipe.hook) {
    try {
      const hookResult = await executePackagedHook(recipe.hook, {
        params,
        headers: requestHeaders,
        document,
        cookieString,
      });
      if (typeof hookResult === 'string' && recipe.hook.toLowerCase().includes('csrf')) {
        requestHeaders['X-CSRF-Token'] = hookResult;
      } else if (typeof hookResult === 'object' && hookResult !== null) {
        const resObj = hookResult as Record<string, unknown>;
        if (typeof resObj.headers === 'object' && resObj.headers !== null) {
          Object.assign(requestHeaders, resObj.headers);
        }
        if (typeof resObj.params === 'object' && resObj.params !== null) {
          Object.assign(params, resObj.params);
        }
      }
    } catch (err) {
      return {
        recipeId,
        status: 'ERROR',
        error: {
          code: 'HOOK_EXECUTION_FAILED',
          message: (err as Error).message || `Packaged hook '${recipe.hook}' failed`,
        },
      };
    }
  }

  // 3. Evaluate preconditions before write
  if (recipe.preconditions && recipe.preconditions.length > 0) {
    try {
      await assertPreconditions(recipe.preconditions, {
        params,
        headers: requestHeaders,
        baseOrigin,
        fetchFn,
      });
    } catch (err) {
      if (err instanceof ConflictError) {
        return {
          recipeId,
          status: 'CONFLICT',
          error: {
            code: 'CONFLICT',
            message: err.message,
            details: err.details,
          },
        };
      }
      return {
        recipeId,
        status: 'ERROR',
        error: {
          code: 'PRECONDITION_FAILED',
          message: (err as Error).message,
        },
      };
    }
  }

  // 4. Build URL & body
  let interpolatedPath: string;
  try {
    interpolatedPath = interpolatePath(recipe.path, params);
  } catch (err) {
    return {
      recipeId,
      status: 'ERROR',
      error: {
        code: 'PATH_INTERPOLATION_FAILED',
        message: (err as Error).message,
      },
    };
  }

  let targetUrl = `${baseOrigin.replace(/\/$/, '')}${interpolatedPath}`;
  if (recipe.method === 'GET' && options.params) {
    const urlObj = new URL(targetUrl);
    for (const [key, val] of Object.entries(options.params)) {
      if (!recipe.path.includes(`:${key}`) && val !== undefined && val !== null) {
        urlObj.searchParams.set(key, String(val));
      }
    }
    targetUrl = urlObj.toString();
  }
  let bodyStr: string | undefined;

  if (recipe.method === 'POST' || recipe.method === 'PUT') {
    if (!requestHeaders['Content-Type']) {
      requestHeaders['Content-Type'] = 'application/json';
    }
    const bodyObj = buildRequestBody(recipe.bodyTemplate, params);
    bodyStr = JSON.stringify(bodyObj);
  }

  // 5. Execute HTTP request
  let res: Response;
  try {
    res = await fetchFn(targetUrl, {
      method: recipe.method,
      headers: requestHeaders,
      body: bodyStr,
      credentials: 'include',
    });
  } catch (err) {
    return {
      recipeId,
      status: 'ERROR',
      error: {
        code: 'CMS_NETWORK_ERROR',
        message: (err as Error).message || 'Network error communicating with CMS',
      },
    };
  }

  // Parse JSON response if present
  let json: Record<string, unknown> = {};
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      json = (await res.json()) as Record<string, unknown>;
    } catch {
      json = {};
    }
  }

  // Handle status codes according to Concurrency & Fault Taxonomy
  if (res.status === 401) {
    return {
      recipeId,
      status: 'ERROR',
      error: { code: 'UNAUTHORIZED', message: (json.message as string) || 'CMS session expired or missing' },
    };
  }

  if (res.status === 403) {
    return {
      recipeId,
      status: 'ERROR',
      error: { code: 'FORBIDDEN', message: (json.message as string) || 'Insufficient staff privileges' },
    };
  }

  if (res.status === 409) {
    return {
      recipeId,
      status: 'CONFLICT',
      error: {
        code: 'CONFLICT',
        message: (json.message as string) || 'Concurrency conflict or slot clash',
        details: json,
      },
    };
  }

  if (res.status === 429) {
    return {
      recipeId,
      status: 'RATE_LIMITED',
      error: { code: 'RATE_LIMITED', message: (json.message as string) || 'CMS rate limit exceeded' },
    };
  }

  if (res.status === 404) {
    return {
      recipeId,
      status: 'ERROR',
      error: { code: 'NOT_FOUND', message: (json.message as string) || 'Resource not found' },
    };
  }

  if (!res.ok) {
    return {
      recipeId,
      status: 'ERROR',
      error: {
        code: 'CMS_REQUEST_FAILED',
        message: (json.message as string) || `CMS returned HTTP ${res.status}`,
      },
    };
  }

  // 6. Extract result data
  const rawData = recipe.extractor ? extractField(json, recipe.extractor) : (json.data ?? json);

  // 7. Read-after-write verification for write recipes (AGENTS.md Rule 10)
  let writeReceipt: WriteReceipt | undefined;
  if (recipe.type === 'write' && recipe.verification) {
    try {
      writeReceipt = await executeWriteVerification(recipe.verification, {
        baseOrigin,
        params,
        writeResponseData: json,
        headers: requestHeaders,
        fetchFn,
      });
    } catch (err) {
      return {
        recipeId,
        status: 'ERROR',
        error: {
          code: 'VERIFICATION_FAILED',
          message: (err as Error).message || 'Read-after-write verification failed',
        },
      };
    }
  }

  if (options.params) {
    Object.assign(options.params, params);
  }

  return {
    recipeId,
    status: 'SUCCESS',
    data: rawData,
    writeReceipt,
  };
}
