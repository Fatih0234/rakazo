import { defineConfig } from "@lingui/conf";
import { formatter } from "@lingui/format-po";

export default defineConfig({
  // Line numbers in origin comments make every unrelated source edit churn the
  // catalogs; file origins stay, so translators keep their context.
  format: formatter({ lineNumbers: false }),
  sourceLocale: "en",
  locales: ["en", "de", "ko", "tr", "hi", "pt-BR", "zh-CN", "es", "ru", "fr"],
  catalogs: [
    {
      path: "<rootDir>/src/locales/{locale}/messages",
      include: ["src"],
      exclude: ["**/locales/**", "**/*.test.*"],
    },
  ],
  compileNamespace: "es",
});
