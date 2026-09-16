import { ChatMarkdown } from "@rakazo/chat-ui/web";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

describe("ChatMarkdown", () => {
  it("renders the formatting commonly emitted by assistants", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"## Capabilities\n\n- **Write files**\n- Run `commands`"}</ChatMarkdown>,
    );

    expect(html).toContain("<h2>Capabilities</h2>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<strong>Write files</strong>");
    expect(html).toContain("<code>commands</code>");
  });

  it("does not inject raw HTML or unsafe link protocols", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{'<script>alert("xss")</script> [bad](javascript:alert(1))'}</ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).not.toContain("javascript:");
  });

  it("renders incomplete streaming code fences as code", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown streaming>{"```ts\nconst live = true;"}</ChatMarkdown>,
    );

    expect(html).toContain("<pre>");
    expect(html).toContain("const live = true;");
    expect(html).toContain("rk-chat-markdown-cursor");
  });

  it("renders a copy button alongside each code block", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"```ts\nconst value = 1;\n```"}</ChatMarkdown>,
    );

    expect(html).toContain("rk-chat-markdown-pre-wrap");
    expect(html).toContain('aria-label="Copy code"');
    expect(html).toContain("rk-chat-markdown-copy");
  });

  it("renders GFM tables as an interactive table card", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>
        {"| Product | Price |\n| --- | ---: |\n| Alpha | 3 |\n| Beta | 10 |"}
      </ChatMarkdown>,
    );

    expect(html).toContain('data-testid="table-card"');
    expect(html).toContain('aria-label="Sort by Product"');
    expect(html).toContain('aria-sort="none"');
    expect(html).toContain('aria-label="Copy rows"');
    expect(html).toContain('aria-label="Download CSV"');
    expect(html).toContain('aria-label="Expand table"');
    expect(html).toContain("Alpha");
    expect(html).toContain("2 rows");
  });

  it("right-aligns numeric table columns", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"| Item | Qty |\n| --- | --- |\n| widget | 12 |"}</ChatMarkdown>,
    );

    expect(html).toContain("rk-align-right");
  });

  it("keeps table cell content sanitized", () => {
    const html = renderToStaticMarkup(
      <ChatMarkdown>{"| A |\n| --- |\n| <script>alert(1)</script> |"}</ChatMarkdown>,
    );

    expect(html).not.toContain("<script");
    expect(html).toContain('data-testid="table-card"');
  });
});
