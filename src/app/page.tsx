import { ChatApp } from '@/components/ChatApp';
import { isTracingEnabled } from '@/lib/tracing';

/**
 * Server shell around the client app.
 *
 * Its only job is to read whether tracing is configured on the server and hand
 * that down, so the "your questions go to Langfuse" notice is present in the
 * first HTML the browser receives. Resolving it through a client fetch would
 * make a privacy disclosure conditional on a round trip succeeding — which is
 * the wrong dependency for that particular piece of text.
 */
export default function Page() {
  return <ChatApp tracing={isTracingEnabled()} />;
}
