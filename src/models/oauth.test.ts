import { describe, expect, it } from "vitest";
import type { Credential } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { PiOAuth } from "./oauth.js";

function runtimeStub(): Pick<ModelRuntime, "login" | "listCredentials"> & { input: string | undefined } {
  let connected = false;
  const stub = {
    input: undefined as string | undefined,
    async listCredentials() { return connected ? [{ providerId: "openai-codex", type: "oauth" as const }] : []; },
    login: async (...args: Parameters<ModelRuntime["login"]>): Promise<Credential> => {
      const [provider, method, interaction] = args;
      expect(provider).toBe("openai-codex");
      expect(method).toBe("oauth");
      expect(await interaction.prompt({ type: "select", message: "method",
        options: [{ id: "browser", label: "Browser" }] })).toBe("browser");
      interaction.notify({ type: "auth_url", url: "https://auth.openai.com/oauth/authorize?state=expected" });
      stub.input = await interaction.prompt({ type: "manual_code", message: "Redirect" });
      const state = new URL(stub.input).searchParams.get("state");
      if (state !== "expected") throw new Error("State mismatch SECRET-PAYLOAD");
      connected = true;
      return { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: 0 };
    },
  };
  return stub;
}

describe("UI OAuth", () => {
  it("starts once, accepts a complete redirect and returns no credential data", async () => {
    const runtime = runtimeStub();
    const oauth = new PiOAuth(runtime);
    const start = await oauth.start();
    const login = start.login;
    if (!login) throw new Error("Login missing");
    expect(login.phase).toBe("awaiting_redirect");
    expect((await oauth.start()).login?.id).toBe(login.id);
    const exchanging = await oauth.finish(login.id, "http://localhost:1455/auth/callback?code=fake-code&state=expected");
    expect(exchanging.login?.phase).toBe("exchanging");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const status = await oauth.status();
    expect(status.connected).toBe(true);
    expect(status.login?.phase).toBe("complete");
    expect(status.login?.authorizationUrl).toBeUndefined();
    expect(JSON.stringify(status)).not.toMatch(/fake-access|fake-refresh|fake-code/);
  });

  it("rejects code-only input, missing state, wrong flow IDs and duplicate finish", async () => {
    const oauth = new PiOAuth(runtimeStub());
    const status = await oauth.start();
    const id = status.login?.id ?? "";
    await expect(oauth.finish(id, "fake-code")).rejects.toThrow("complete");
    await expect(oauth.finish(id, "http://localhost:1455/auth/callback?code=fake-code")).rejects.toThrow("state");
    await expect(oauth.finish("wrong-id", "http://localhost:1455/auth/callback?code=fake-code&state=expected"))
      .rejects.toThrow("No active");
    await oauth.finish(id, "http://localhost:1455/auth/callback?code=fake-code&state=expected");
    await expect(oauth.finish(id, "http://localhost:1455/auth/callback?code=fake-code&state=expected"))
      .rejects.toThrow("No active");
  });

  it("lets Pi reject mismatched state and sanitizes login failures", async () => {
    const oauth = new PiOAuth(runtimeStub());
    const status = await oauth.start();
    await oauth.finish(status.login?.id ?? "", "http://localhost:1455/auth/callback?code=fake-code&state=wrong");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await oauth.status()).login?.phase).toBe("failed");
    expect(JSON.stringify(await oauth.status())).not.toContain("SECRET-PAYLOAD");
  });

  it("cancels pending input and expires abandoned flows", async () => {
    const oauth = new PiOAuth(runtimeStub(), 10);
    await oauth.start();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect((await oauth.status()).login?.phase).toBe("cancelled");
    const restarted = await oauth.start();
    expect(restarted.login?.phase).toBe("awaiting_redirect");
    await oauth.cancel(restarted.login?.id);
    expect((await oauth.status()).login?.phase).toBe("cancelled");
  });
});
