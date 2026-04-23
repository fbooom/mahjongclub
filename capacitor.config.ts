import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ourmahjong.club.app",
  appName: "Mahjong Club",
  webDir: "dist",
  plugins: {
    PushNotifications: {
      // Show banners, badge count, and play sound when app is in foreground
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
};

export default config;
