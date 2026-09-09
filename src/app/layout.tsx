import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n";
// FSI EXPANSION: global industry-mode provider.
import { IndustryProvider } from "@/lib/industry-context";
// Multi-dataset isolation: active demo dataset provider.
import { DatasetProvider } from "@/lib/dataset-context";

export const metadata: Metadata = {
  title: "Property Operations Assistant — Atlas Retrieval Demo",
  description:
    "MongoDB Atlas hybrid search + reranking + RAG over a property-management operations corpus.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // lang is updated client-side by I18nProvider based on the saved preference.
  return (
    <html lang="en">
      <body>
        <I18nProvider>
          <IndustryProvider>
            <DatasetProvider>{children}</DatasetProvider>
          </IndustryProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
