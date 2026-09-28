import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "GameGarden",
  description: "Grow your indie game's social presence with AI-assisted, approval-first recommendations.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
