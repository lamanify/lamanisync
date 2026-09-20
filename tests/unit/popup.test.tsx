import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { App } from '../../src/popup/App';

describe('Popup App Component', () => {
  beforeEach(() => {
    // Setup chrome.runtime.getManifest mock
    (globalThis as unknown as { chrome: unknown }).chrome = {
      runtime: {
        getManifest: vi.fn(() => ({
          version: '0.1.0',
          name: 'LamaniSync Dev',
        })),
      },
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders extension title and Unpaired state', () => {
    render(<App />);

    expect(screen.getByText('LamaniSync Dev')).toBeTruthy();
    expect(screen.getByText('Unpaired')).toBeTruthy();
  });

  it('dynamically displays version from manifest instead of hardcoded value', () => {
    render(<App />);

    const versionElement = screen.getByTestId('extension-version');
    expect(versionElement.textContent).toBe('v0.1.0');
  });
});
