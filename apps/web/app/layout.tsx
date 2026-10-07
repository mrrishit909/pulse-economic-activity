import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PULSE · global economic activity",
  description: "Live-style map of synthetic trade flows, port congestion and a regional activity nowcast that reads ahead of a lagging official indicator.",
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#03050a" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
