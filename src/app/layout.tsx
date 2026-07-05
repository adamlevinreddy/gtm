import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { ClerkProvider } from "@clerk/nextjs";
import ChatDock from "@/components/ChatDock";
import "./globals.css";

// Enforced-auth mode is gated on the Clerk publishable key so local dev (no
// keys) renders without a provider and stays on the picker gate.
const CLERK_ON = !!process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY;

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { template: "%s · Reddy GTM", default: "Reddy GTM" },
  description: "Meetings, accounts, and the team brain — in one place.",
  icons: {
    icon: `data:image/svg+xml,${encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#773D72"/><text x="16" y="22" font-family="system-ui,sans-serif" font-size="17" font-weight="700" fill="#fff" text-anchor="middle">R</text></svg>'
    )}`,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const tree = (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        {children}
        {/* Root-level so a running chat survives page navigation (minimize →
            browse anywhere → expand). Renders nothing until askReddy() fires. */}
        <ChatDock />
      </body>
    </html>
  );
  // afterSignOutUrl routes Clerk sign-out through our logout route, which
  // clears the signed viewer cookie before landing on home.
  return CLERK_ON ? <ClerkProvider afterSignOutUrl="/api/auth/logout">{tree}</ClerkProvider> : tree;
}
