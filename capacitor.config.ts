import { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  appId: "ourmahjong.club.app",
  appName: "Mahjong Club",
  webDir: "dist",
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
    GoogleAuth: {
      iosClientId: "744873688381-5bbp19nctmht9pn4mm1cek46hqsjnd8v.apps.googleusercontent.com",
      androidClientId: "744873688381-a12j7rdj7cpfjedddvfn2ejjobmt2p6t.apps.googleusercontent.com",
      scopes: ["profile", "email"],
      serverClientId: "744873688381-a12j7rdj7cpfjedddvfn2ejjobmt2p6t.apps.googleusercontent.com",
      forceCodeForRefreshToken: true,
    },
  },
};

export default config;
