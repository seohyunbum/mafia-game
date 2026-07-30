import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import "./globals.css";

/**
 * 배포본의 정본 주소. 표준 실행 경로가 이 URL 이다 (README §실행 표면).
 *
 * 메타데이터를 요청 host 로만 만들면, Pages 배포본을 **프리렌더할 때의 임시 서버 주소**가
 * 아이콘·og 링크에 그대로 굳는다(실측: `http://127.0.0.1:4123/mafia-icon.png`). 배포 빌드에는
 * PAGES_SITE_ORIGIN 을 주고, 없으면 요청 host 를 쓴다.
 */
const SITE_ORIGIN = process.env.PAGES_SITE_ORIGIN ?? null;

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host =
    requestHeaders.get("x-forwarded-host") ??
    requestHeaders.get("host") ??
    "localhost:4180";
  const protocol =
    requestHeaders.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.0.0.1")
      ? "http"
      : "https");
  const origin = SITE_ORIGIN ?? `${protocol}://${host}`;
  const socialImage = `${origin}/og.png`;

  return {
    metadataBase: new URL(origin),
    title: {
      default: "밤의 의회 — 마피아 게임",
      template: "%s | 밤의 의회",
    },
    description:
      "열두 명의 원탁에서 펼쳐지는 시민·마피아·교주 3진영 심리전",
    applicationName: "밤의 의회",
    icons: {
      icon: "/mafia-icon.png",
      shortcut: "/mafia-icon.png",
      apple: "/mafia-icon.png",
    },
    manifest: "/manifest.webmanifest",
    openGraph: {
      type: "website",
      url: origin,
      title: "밤의 의회 — 마피아 게임",
      description:
        "열두 명의 원탁에서 펼쳐지는 시민·마피아·교주 3진영 심리전",
      siteName: "밤의 의회",
      locale: "ko_KR",
      images: [
        {
          url: socialImage,
          width: 1672,
          height: 941,
          alt: "붉은 달 아래 열두 명이 모인 밤의 의회",
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: "밤의 의회 — 마피아 게임",
      description:
        "시민·마피아·교주가 맞서는 9인 온라인 사회 추리 게임",
      images: [socialImage],
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#090909",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
