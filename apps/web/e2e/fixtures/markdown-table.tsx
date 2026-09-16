import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { createRoot } from "react-dom/client";
import "../../src/styles.css";

const params = new URLSearchParams(location.search);
const rowCount = Number(params.get("rows") ?? "12");

const rows = Array.from(
  { length: rowCount },
  (_, i) => `| item-${String(i + 1).padStart(2, "0")} | ${(i * 7) % 13} |`,
);
const markdown = ["| Item | Qty |", "| --- | --- |", ...rows].join("\n");

createRoot(document.getElementById("root")!).render(
  <main className="min-h-screen bg-background p-8 text-foreground">
    <div style={{ maxWidth: "40rem" }}>
      <ChatMarkdown>{markdown}</ChatMarkdown>
    </div>
  </main>,
);
