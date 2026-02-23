// desktop/scripts/notarize.js
// Notarizes the macOS app after signing.
// Requires an Apple Developer account and the following env vars:
//   APPLE_ID          — your Apple ID email
//   APPLE_ID_PASSWORD — app-specific password (NOT your main password)
//   APPLE_TEAM_ID     — your 10-char team ID
//
// To generate an app-specific password:
//   1. Go to appleid.apple.com → Sign-In and Security → App-Specific Passwords
//   2. Generate one and store it securely
//
// To skip notarization during dev, just don't set these env vars.

const { notarize } = require("@electron/notarize");

exports.default = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== "darwin") return;

  const appleId = process.env.APPLE_ID;
  const appleIdPassword = process.env.APPLE_ID_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  if (!appleId || !appleIdPassword || !teamId) {
    console.log("Skipping notarization — APPLE_ID / APPLE_ID_PASSWORD / APPLE_TEAM_ID not set");
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  console.log(`Notarizing ${appName}...`);

  await notarize({
    appBundleId: "com.axle.desktop",
    appPath: `${appOutDir}/${appName}.app`,
    appleId,
    appleIdPassword,
    teamId,
  });

  console.log("Notarization complete");
};
