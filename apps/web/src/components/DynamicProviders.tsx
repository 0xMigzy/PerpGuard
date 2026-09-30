'use client';

import { useEffect, type ReactNode } from 'react';
import { DynamicContextProvider, useDynamicContext } from '@dynamic-labs/sdk-react-core';
import { EthereumWalletConnectors } from '@dynamic-labs/ethereum';
import { exchangeDynamicSession, notifySessionChanged, registerDynamicLogout } from '@/lib/session.ts';

/** The environment id is public by design: it names the Dynamic project, not a secret. */
export const DYNAMIC_ENVIRONMENT_ID = process.env['NEXT_PUBLIC_DYNAMIC_ENVIRONMENT_ID']?.trim() || undefined;

/**
 * Dynamic around the whole app, when it is configured.
 *
 * On a successful login the SDK's JWT is exchanged, once, for the backend's
 * own HttpOnly session; on logout that session is closed too. The exchange
 * is the only place the token is read, and it goes to PerpGuard's backend and
 * nowhere else.
 */
export function DynamicProviders({ children }: { readonly children: ReactNode }) {
  if (DYNAMIC_ENVIRONMENT_ID === undefined) return <>{children}</>;
  return (
    <DynamicContextProvider
      settings={{
        environmentId: DYNAMIC_ENVIRONMENT_ID,
        walletConnectors: [EthereumWalletConnectors],
        events: {
          onAuthSuccess: () => {
            void exchangeDynamicSession();
          },
          onLogout: () => {
            notifySessionChanged();
          },
        },
      }}
    >
      <LogoutBridge />
      {children}
    </DynamicContextProvider>
  );
}

/** Hands the SDK's own logout to the session module, so Sign out ends both sessions. */
function LogoutBridge() {
  const { handleLogOut } = useDynamicContext();
  useEffect(() => {
    registerDynamicLogout(handleLogOut);
    return () => registerDynamicLogout(undefined);
  }, [handleLogOut]);
  return null;
}
