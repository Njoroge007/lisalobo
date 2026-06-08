import { createFileRoute } from "@tanstack/react-router";
import { V75Analyzer } from "@/components/v75/V75Analyzer";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "V75 Analyzer — Volatility 75 Rise/Fall Signals" },
      { name: "description", content: "Real-time Volatility 75 Index analysis with SMC, multi-timeframe confluence, and adaptive pattern learning for Deriv Smart Trader." },
      { property: "og:title", content: "V75 Analyzer" },
      { property: "og:description", content: "Professional V75 Rise/Fall analysis tool." },
    ],
  }),
  component: Index,
});

function Index() {
  return <V75Analyzer />;
}
