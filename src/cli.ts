import { login } from "./telegram/client.js";
import { TelegramSetupError } from "./telegram/input.js";

const command = process.argv[2];
try {
  if (command === "login") {
    await login();
    console.log("Telegram login complete. The protected session has been saved.");
  } else if (command === "discover" || command === "smoke") {
    const { runTelegramCommand } = await import("./telegram/commands.js");
    await runTelegramCommand(command, process.argv.slice(3));
  } else {
    console.log("Usage: npm run cli -- <login|discover|smoke>\nOr: npx tsx --env-file-if-exists=.env src/cli.ts <login|discover|smoke>");
    process.exitCode = command ? 1 : 0;
  }
} catch (error) {
  // Unknown errors may include request contents, database values or credentials.
  console.error(error instanceof TelegramSetupError ? error.message :
    "Telegram command failed. Check configuration, database and Telegram connectivity.");
  process.exitCode = 1;
}
