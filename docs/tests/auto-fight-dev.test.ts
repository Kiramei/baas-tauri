import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = (locale: string) =>
  readFileSync(new URL(`../content/docs/${locale}/reference/auto-fight-dev.mdx`, import.meta.url), "utf8");

const expectedCode = `if pass_method == 1:
    image_bytes = self.get_image_bytes(origin_image)
    files = {
        "data": (None, json.dumps(data), "application/json"),
        "image": ("image.png", image_bytes, "image/png")
    }
    return requests.post(url, files=files)`;

test("both auto-fight guides preserve the illustrated branches and OCR example", () => {
  for (const locale of ["zh", "en"]) {
    const content = source(locale);
    const diagrams = [...content.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((match) => match[1]);
    expect(diagrams).toHaveLength(3);
    for (const edge of [
      "Restart --> Start",
      "Skill1 -->|",
      "| Restart",
      "| Skill2",
      "Skill2 -->|",
      "| End",
    ]) expect(diagrams[1]).toContain(edge);
    for (const edge of [
      "Extract -->|",
      "Queue --> Empty",
      "Wait --> Condition",
      "| Submit",
      "Submit --> Pool",
      "| Empty",
    ]) expect(diagrams[2]).toContain(edge);
    expect(diagrams[2]).toContain("running_thread_count < max_thread");
    expect(content.match(/```python\n([\s\S]*?)```/)?.[1].trimEnd()).toBe(expectedCode);
    for (const image of [
      "auto_fight/total_assault_general.webp",
      "game_feature/static_feature_example.webp",
      "game_feature/swipe_example_common_shop.webp",
    ]) expect(content).toContain(`/backend-assets/${image}`);
    expect(content).not.toContain("procedure_draft.webp");
    expect(content).not.toContain("screenshot_data_update_cycle.webp");
    expect(content).not.toContain("pass_method1_example.webp");
  }
  expect(source("zh")).toContain('"血量 > 500w"');
  expect(source("en")).toContain('"HP > 5,000,000"');
});
