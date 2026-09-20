import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { PairingView } from '../../src/popup/states/PairingView';

describe('PairingView Component', () => {
  it('renders unpaired view with input and invokes onPair on submit', () => {
    const onPair = vi.fn();
    const onGrantPermission = vi.fn();
    const onUnpair = vi.fn();

    render(
      <PairingView
        connectionState="UNPAIRED"
        onPair={onPair}
        onGrantPermission={onGrantPermission}
        onUnpair={onUnpair}
      />
    );

    const input = screen.getByTestId('pairing-code-input') as HTMLInputElement;
    const pairBtn = screen.getByTestId('pair-button');

    expect(input).toBeDefined();
    expect(pairBtn).toBeDefined();

    // Type lowercase code, should uppercase
    fireEvent.change(input, { target: { value: 'pair-abc' } });
    expect(input.value).toBe('PAIR-ABC');

    fireEvent.click(pairBtn);
    expect(onPair).toHaveBeenCalledWith('PAIR-ABC');
  });

  it('displays error banner when errorMessage is passed', () => {
    render(
      <PairingView
        connectionState="UNPAIRED"
        errorMessage="The pairing code has expired"
        onPair={vi.fn()}
        onGrantPermission={vi.fn()}
        onUnpair={vi.fn()}
      />
    );

    const errorBanner = screen.getByTestId('pairing-error');
    expect(errorBanner.textContent).toBe('The pairing code has expired');
  });

  it('renders PAIRED_NO_PERMISSION view with exact origin and triggers onGrantPermission on user click', () => {
    const onGrantPermission = vi.fn();
    const onUnpair = vi.fn();

    render(
      <PairingView
        connectionState="PAIRED_NO_PERMISSION"
        targetOrigin="http://localhost:4001"
        clinicId="CLN-001"
        onPair={vi.fn()}
        onGrantPermission={onGrantPermission}
        onUnpair={onUnpair}
      />
    );

    expect(screen.getByTestId('paired-no-permission-view')).toBeDefined();
    expect(screen.getByTestId('target-origin').textContent).toBe('http://localhost:4001');

    const grantBtn = screen.getByTestId('grant-permission-button');
    fireEvent.click(grantBtn);
    expect(onGrantPermission).toHaveBeenCalledTimes(1);

    const unpairBtn = screen.getByTestId('unpair-button');
    fireEvent.click(unpairBtn);
    expect(onUnpair).toHaveBeenCalledTimes(1);
  });

  it('renders connected view with unpair button when in PROBING state', () => {
    const onUnpair = vi.fn();

    render(
      <PairingView
        connectionState="PROBING"
        targetOrigin="http://localhost:4001"
        onPair={vi.fn()}
        onGrantPermission={vi.fn()}
        onUnpair={onUnpair}
      />
    );

    expect(screen.getByTestId('connected-view')).toBeDefined();
    expect(screen.getByTestId('target-origin').textContent).toBe('http://localhost:4001');

    const unpairBtn = screen.getByTestId('unpair-button');
    fireEvent.click(unpairBtn);
    expect(onUnpair).toHaveBeenCalledTimes(1);
  });
});
