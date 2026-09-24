#!/usr/bin/env node
/**
 * Automated Responsive Audit Script for LamaniSync Website
 * Tests all 11 static routes across required mobile/tablet viewports (320px, 360px, 375px, 390px, 414px, 768px).
 * Verifies:
 *  1. Zero horizontal overflow (both naturally unclipped and clamped).
 *  2. No off-screen clipped elements exceeding viewport width.
 *  3. Code blocks and table wrappers properly enable horizontal touch scrolling.
 *  4. Interactive buttons, tabs, and form controls maintain accessible touch target sizes (>= 44px height).
 *  5. Interactive components (PlatformShowcase tabs, mobile navigation drawer) remain responsive across states.
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DIST_DIR = path.resolve(__dirname, '../website/dist');

if (!fs.existsSync(DIST_DIR)) {
  console.error(`Dist directory not found at ${DIST_DIR}. Please run "npm run build" in website/ first.`);
  process.exit(1);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

const server = http.createServer((req, res) => {
  let cleanUrl = req.url?.split('?')[0] || '/';
  let filePath = path.join(DIST_DIR, cleanUrl);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    filePath = path.join(filePath, 'index.html');
  } else if (!fs.existsSync(filePath) && fs.existsSync(filePath + '.html')) {
    filePath = filePath + '.html';
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': contentType });
  fs.createReadStream(filePath).pipe(res);
});

const VIEWPORTS = [
  { width: 320, height: 600, label: '320px (iPhone SE / Smallest mobile)' },
  { width: 360, height: 740, label: '360px (Standard Android / Galaxy)' },
  { width: 375, height: 667, label: '375px (iPhone 8 / Mini)' },
  { width: 390, height: 844, label: '390px (iPhone 12/13/14/15)' },
  { width: 414, height: 896, label: '414px (iPhone Plus / Max)' },
  { width: 768, height: 1024, label: '768px (iPad / Tablet portrait)' },
];

const BASE_PAGES = [
  '/',
  '/what-is-synchronizer',
  '/why-we-dont-partner',
  '/features',
  '/blog',
  '/docs',
];

const FOOTER_PAGES = [
  '/contact',
  '/privacy',
];

// Dynamically discover all blog post routes from dist/blog
const ALL_14_BLOG_ROUTES = [
  '/blog/the-walled-garden-in-healthcare-cms',
  '/blog/why-readback-verification-is-mandatory',
  '/blog/manifest-v3-vs-background-windows-services',
  '/blog/connecting-whatsapp-ai-to-legacy-ehrs',
  '/blog/the-zero-disk-guarantee-ephemeral-memory',
  '/blog/why-we-dont-trust-blind-writes-readback-verification',
  '/blog/bank-grade-cryptography-webcrypto-ed25519-keys',
  '/blog/zero-open-ports-clinic-network-security',
  '/blog/zero-knowledge-session-hygiene-cms-passwords',
  '/blog/double-booking-shield-idempotency-mutex-locks',
  '/blog/surgical-permissions-manifest-v3-clinic-portal',
  '/blog/data-sovereignty-medical-compliance-pdpa-hipaa',
  '/blog/predefined-action-whitelists-zero-remote-code',
  '/blog/cryptographic-receipt-sha-256-state-hashing',
];

const blogDistDir = path.join(DIST_DIR, 'blog');
const discoveredBlogRoutes = fs.existsSync(blogDistDir)
  ? fs.readdirSync(blogDistDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/blog/${entry.name}`)
      .sort()
  : ALL_14_BLOG_ROUTES;

if (discoveredBlogRoutes.length < 14) {
  console.error(`ERROR: Expected at least 14 blog routes in dist/blog, found ${discoveredBlogRoutes.length}. Please run "npm run build" in website/ first.`);
  process.exit(1);
}

// Dynamically discover all docs routes from dist/docs
const ALL_10_DOCS_ROUTES = [
  '/docs/installation-guide',
  '/docs/quickstart-lamanihub',
  '/docs/dentrix-ascend-setup',
  '/docs/eclinicalworks-setup',
  '/docs/lamanipulse-setup',
  '/docs/custom-web-cms',
  '/docs/multi-workstation-redundancy',
  '/docs/security-and-firewall',
  '/docs/troubleshooting-pairing',
  '/docs/faq',
];

const docsDistDir = path.join(DIST_DIR, 'docs');
const discoveredDocsRoutes = fs.existsSync(docsDistDir)
  ? fs.readdirSync(docsDistDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `/docs/${entry.name}`)
      .sort()
  : ALL_10_DOCS_ROUTES;

if (discoveredDocsRoutes.length < 10) {
  console.error(`ERROR: Expected at least 10 docs routes in dist/docs, found ${discoveredDocsRoutes.length}. Please run "npm run build" in website/ first.`);
  process.exit(1);
}

const PAGES = [...BASE_PAGES, ...discoveredBlogRoutes, ...discoveredDocsRoutes, ...FOOTER_PAGES];

async function runAudit() {
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;

  console.log(`\n======================================================`);
  console.log(` LamaniSync Mobile Responsiveness Automated Audit`);
  console.log(` Serving dist from: ${DIST_DIR}`);
  console.log(` Testing ${PAGES.length} routes x ${VIEWPORTS.length} viewports (${PAGES.length * VIEWPORTS.length} combinations)`);
  console.log(`======================================================\n`);

  let browser;
  try {
    browser = await chromium.launch({ channel: 'chrome', headless: true });
  } catch (err) {
    browser = await chromium.launch({ headless: true });
  }

  let totalTests = 0;
  let failures = [];

  for (const vp of VIEWPORTS) {
    console.log(`--> Auditing Viewport: ${vp.width}px x ${vp.height}px [${vp.label}]`);
    const page = await browser.newPage({
      viewport: { width: vp.width, height: vp.height },
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.5 Mobile/15E148 Safari/604.1',
    });

    for (const route of PAGES) {
      totalTests++;
      const targetUrl = `${baseUrl}${route}`;
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(50);

      const auditResult = await page.evaluate((vpWidth) => {
        // 1. Natural overflow test without overflow-x: hidden masking
        const originalHtmlOverflow = document.documentElement.style.overflowX;
        const originalBodyOverflow = document.body.style.overflowX;
        const main = document.querySelector('main');
        const originalMainOverflow = main ? main.style.overflowX : '';

        document.documentElement.style.overflowX = 'visible';
        document.body.style.overflowX = 'visible';
        if (main) main.style.overflowX = 'visible';

        const naturalDocWidth = document.documentElement.scrollWidth;
        const naturalBodyWidth = document.body.scrollWidth;
        const naturalMax = Math.max(naturalDocWidth, naturalBodyWidth);

        // Restore styles
        document.documentElement.style.overflowX = originalHtmlOverflow;
        document.body.style.overflowX = originalBodyOverflow;
        if (main) main.style.overflowX = originalMainOverflow;

        const docWidth = document.documentElement.scrollWidth;
        const winWidth = window.innerWidth;
        const overflow = (docWidth > winWidth + 1) || (naturalMax > winWidth + 2);

        // 2. Check for elements visibly exceeding viewport width without horizontal scroll container
        const offenders = [];
        const allElements = document.querySelectorAll('*');
        for (const el of allElements) {
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          const isScrollable = style.overflowX === 'auto' || style.overflowX === 'scroll';

          if (rect.right > winWidth + 2 && !isScrollable) {
            // Check if element has scrollable ancestor
            let parent = el.parentElement;
            let insideScrollable = false;
            while (parent && parent !== document.body) {
              const pStyle = window.getComputedStyle(parent);
              if (pStyle.overflowX === 'auto' || pStyle.overflowX === 'scroll') {
                insideScrollable = true;
                break;
              }
              parent = parent.parentElement;
            }
            if (!insideScrollable) {
              offenders.push({
                tag: el.tagName.toLowerCase(),
                className: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
                id: el.id || '',
                right: Math.round(rect.right),
                width: Math.round(rect.width),
              });
              if (offenders.length >= 3) break;
            }
          }
        }

        // 3. Check code blocks and tables for proper scroll container styles
        const codeAndTables = [];
        const codeBlocks = document.querySelectorAll('pre, .article-code, .table-container, .table-wrapper, .perm-table-wrapper');
        for (const block of codeBlocks) {
          const style = window.getComputedStyle(block);
          const hasScroll = style.overflowX === 'auto' || style.overflowX === 'scroll';
          if (!hasScroll || block.scrollWidth > block.clientWidth && !hasScroll) {
            codeAndTables.push({
              tag: block.tagName.toLowerCase(),
              className: typeof block.className === 'string' ? block.className : '',
              overflowX: style.overflowX,
            });
          }
        }

        // 4. Verify touch target heights (>= 44px) for all interactive buttons, tabs, links, and inputs
        const smallTouchTargets = [];
        const interactiveSelectors = 'button, [role="tab"], [role="button"], .tab-btn, .btn-primary, .btn-secondary, .btn-dark, .mobile-link, .mobile-menu-btn, .announcement-close, .announcement-link, input, select, textarea, .post-link';
        const interactiveElements = document.querySelectorAll(interactiveSelectors);

        for (const el of interactiveElements) {
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') continue;
          if (el.offsetParent === null && style.position !== 'fixed') continue;

          const rect = el.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          // WCAG 2.1 touch target height >= 44px
          if (rect.height < 44) {
            smallTouchTargets.push({
              tag: el.tagName.toLowerCase(),
              className: typeof el.className === 'string' ? el.className.slice(0, 40) : '',
              text: (el.textContent || '').trim().slice(0, 25),
              height: Math.round(rect.height),
              width: Math.round(rect.width),
            });
            if (smallTouchTargets.length >= 3) break;
          }
        }

        return {
          docWidth,
          naturalMax,
          winWidth,
          overflow,
          offenders,
          badCodeBlocks: codeAndTables,
          smallTouchTargets,
        };
      }, vp.width);

      // 5. Interactive Route-Specific Tests
      let interactiveIssues = [];
      if (route === '/') {
        // Test switching all 5 tabs in PlatformShowcase
        const tabs = ['tab-btn-sync', 'tab-btn-clashes', 'tab-btn-checkins', 'tab-btn-readbacks', 'tab-btn-security'];
        for (const tabId of tabs) {
          const tabBtn = await page.$(`#${tabId}`);
          if (tabBtn) {
            await tabBtn.click();
            await page.waitForTimeout(30);
            const tabOverflow = await page.evaluate(() => {
              return document.documentElement.scrollWidth > window.innerWidth + 1;
            });
            if (tabOverflow) {
              interactiveIssues.push(`Platform tab #${tabId} causes overflow`);
            }
          }
        }
      }

      if (vp.width <= 768) {
        // Test mobile navigation drawer toggle
        const toggleBtn = await page.$('#mobile-menu-toggle');
        if (toggleBtn) {
          await toggleBtn.click();
          await page.waitForTimeout(100);
          const drawerCheck = await page.evaluate(() => {
            const drawer = document.getElementById('mobile-nav-drawer');
            const isOpen = drawer && drawer.classList.contains('open');
            const drawerOverflow = document.documentElement.scrollWidth > window.innerWidth + 1;
            return { isOpen, drawerOverflow };
          });
          if (drawerCheck.drawerOverflow) {
            interactiveIssues.push('Mobile drawer causes horizontal overflow when opened');
          }
          // Close drawer
          await toggleBtn.click();
          await page.waitForTimeout(50);
        }
      }

      if (route === '/docs') {
        const searchInput = await page.$('#docs-search');
        if (searchInput) {
          await searchInput.fill('Dentrix');
          await page.waitForTimeout(50);
          const searchOverflow = await page.evaluate(() => {
            return document.documentElement.scrollWidth > window.innerWidth + 1;
          });
          if (searchOverflow) {
            interactiveIssues.push('Docs live search causes horizontal overflow');
          }
        }
      }

      if (route.startsWith('/docs/') && vp.width <= 768) {
        const sidebarBtn = await page.$('#docs-sidebar-toggle');
        if (sidebarBtn) {
          await sidebarBtn.click();
          await page.waitForTimeout(50);
          const sidebarOverflow = await page.evaluate(() => {
            return document.documentElement.scrollWidth > window.innerWidth + 1;
          });
          if (sidebarOverflow) {
            interactiveIssues.push('Docs mobile sidebar causes horizontal overflow when opened');
          }
          await sidebarBtn.click();
          await page.waitForTimeout(30);
        }
      }

      const hasFailures = auditResult.overflow ||
        auditResult.offenders.length > 0 ||
        auditResult.badCodeBlocks.length > 0 ||
        auditResult.smallTouchTargets.length > 0 ||
        interactiveIssues.length > 0;

      if (hasFailures) {
        failures.push({
          route,
          viewport: vp.width,
          ...auditResult,
          interactiveIssues,
        });
        console.error(`  FAIL [${vp.width}px] ${route} -> scrollWidth: ${auditResult.docWidth}px, naturalMax: ${auditResult.naturalMax}px, innerWidth: ${auditResult.winWidth}px`);
        if (auditResult.offenders.length > 0) {
          console.error(`    Offenders:`, auditResult.offenders);
        }
        if (auditResult.badCodeBlocks.length > 0) {
          console.error(`    Unscrollable blocks:`, auditResult.badCodeBlocks);
        }
        if (auditResult.smallTouchTargets.length > 0) {
          console.error(`    Small touch targets (<44px):`, auditResult.smallTouchTargets);
        }
        if (interactiveIssues.length > 0) {
          console.error(`    Interactive issues:`, interactiveIssues);
        }
      } else {
        process.stdout.write(`  ✓ [${vp.width}px] ${route}\n`);
      }
    }
    await page.close();
  }

  await browser.close();
  server.close();

  console.log(`\n======================================================`);
  console.log(` Audit Complete: ${totalTests - failures.length}/${totalTests} checks passed.`);
  if (failures.length > 0) {
    console.error(` FAILED: ${failures.length} issues detected across viewports.`);
    process.exit(1);
  } else {
    console.log(` SUCCESS: 100% Mobile Responsive across all tested viewports!`);
    console.log(`======================================================\n`);
    process.exit(0);
  }
}

runAudit().catch((err) => {
  console.error('Audit encountered unexpected error:', err);
  server.close();
  process.exit(1);
});
