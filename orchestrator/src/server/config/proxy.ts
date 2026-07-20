/**
 * Route Node's global `fetch` through the corporate proxy.
 *
 * Node's built-in fetch (undici) ignores HTTP_PROXY/HTTPS_PROXY unless a
 * dispatcher is installed. Bedrock (bedrock-runtime.<region>.amazonaws.com) is
 * a public endpoint, so on a proxied network the LLM calls fail without this.
 * EnvHttpProxyAgent reads HTTP_PROXY / HTTPS_PROXY / NO_PROXY itself, so this is
 * a no-op when none are set. Best-effort: a failure here must not block startup.
 */
export async function installProxyDispatcher(): Promise<void> {
  if (!process.env.HTTPS_PROXY && !process.env.HTTP_PROXY) return;
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new EnvHttpProxyAgent());
  } catch (error) {
    // undici is bundled with Node 22; if the import ever fails, fetch still
    // works for direct (non-proxied) hosts — just log and carry on.
    console.warn(
      "[proxy] Could not install proxy dispatcher; outbound fetch will bypass the proxy.",
      error instanceof Error ? error.message : error,
    );
  }
}
