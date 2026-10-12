import { settingsSchema, type AppSettings } from '../settings.js';

const processingSettings = settingsSchema.omit({ publishingEnabled: true, minimumPublicationScore: true,
  collectionCron: true, digestCron: true, cleanupCron: true, timezone: true }).strip();
export const processingConfiguration = (settings: AppSettings) => processingSettings.parse(settings);
export const processingSettingsChanged = (previous: AppSettings, latest: AppSettings): boolean =>
  JSON.stringify(processingConfiguration(previous)) !== JSON.stringify(processingConfiguration(latest));
