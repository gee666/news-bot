import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions/index.js";
import { Logger, LogLevel } from "telegram/extensions/Logger.js";
import { hiddenInput, TelegramSetupError } from "./input.js";
import { SessionFiles, type SecretPrompt } from "./session.js";

async function createClient(files: SessionFiles, interactive: boolean, prompt: SecretPrompt) {
  await files.prepare();
  const credentials = await files.apiCredentials(interactive, prompt);
  const saved = await files.read("session.txt");
  if (!interactive && !saved) throw new TelegramSetupError("Run the login command first.");
  const session = new StringSession(saved?.trim() ?? "");
  const client = new TelegramClient(session, credentials.apiId, credentials.apiHash, {
    baseLogger: new Logger(LogLevel.NONE),
    connectionRetries: 3,
    requestRetries: 2,
    autoReconnect: false,
  });
  // Library errors can contain request parameters. Never print them.
  client.onError = async () => {};
  return { client, session };
}

export async function login(prompt: SecretPrompt = hiddenInput): Promise<void> {
  if (prompt === hiddenInput && !process.stdin.isTTY) {
    throw new TelegramSetupError("Login requires an interactive terminal.");
  }
  const files = new SessionFiles();
  const { client, session } = await createClient(files, true, prompt);
  try {
    await client.start({
      phoneNumber: async () => {
        const phone = (process.env.TELEGRAM_PHONE?.trim() || await prompt("Phone number with country code")).trim();
        if (!/^\+[1-9]\d{6,14}$/u.test(phone)) {
          throw new TelegramSetupError("Enter a phone number with its +country code.");
        }
        return phone;
      },
      phoneCode: async () => await prompt("Telegram login code"),
      password: async () => await prompt("Telegram two-step-verification password"),
      firstAndLastNames: async () => {
        throw new TelegramSetupError("Use an existing Telegram account. Account registration is disabled.");
      },
      onError: async (error) => {
        if ("errorMessage" in error && error.errorMessage === "PHONE_CODE_INVALID") {
          process.stderr.write("Invalid login code. Try again.\n");
          return false;
        }
        if ("errorMessage" in error && error.errorMessage === "PASSWORD_HASH_INVALID") {
          process.stderr.write("Invalid password. Try again.\n");
          return false;
        }
        throw new TelegramSetupError("Telegram login failed or was cancelled. Check API credentials, phone number and connectivity.");
      },
    });
    if (!await client.checkAuthorization()) throw new TelegramSetupError("Telegram login did not authorize the account.");
    const account = await client.getMe();
    if (account.bot) throw new TelegramSetupError("Use a Telegram user account, not a bot session.");
    await files.write("session.txt", session.save());
  } finally { await client.destroy(); }
}

export async function withUserClient<T>(run: (client: TelegramClient) => Promise<T>): Promise<T> {
  const { client } = await createClient(new SessionFiles(), false, hiddenInput);
  try {
    await client.connect();
    if (!await client.checkAuthorization()) throw new TelegramSetupError("Session is not authorized. Run login again.");
    const account = await client.getMe();
    if (account.bot) throw new TelegramSetupError("Use a Telegram user account, not a bot session.");
    return await run(client);
  } finally { await client.destroy(); }
}
