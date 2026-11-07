import { expect, test } from "bun:test";
import { executeAction, type ActionContext } from "../src/actions";
import { DemoClient } from "../src/demo";
import { getConfigurationField, parseConfigurationValue } from "../src/configuration";

async function lessonClient() {
  const client = new DemoClient();
  await client.patchConfig("sensei-cn", "/lesson_times", [0]);
  await client.patchConfig("sensei-cn", "/lesson_each_region_object_priority", [["advanced"]]);
  client.staticData = async () => ({ lesson_region_name: { CN: ["一", "二", "三"] } });
  return client;
}

test("lesson table saves extend every area's count through the real action boundary", async () => {
  const client = await lessonClient();
  const approvals: Record<string, unknown>[] = [];
  const context: ActionContext = {
    client: async () => client,
    profile: "sensei-cn",
    readOnly: false,
    approve: async (_, args) => {
      approvals.push(args);
      return true;
    },
  };
  const field = getConfigurationField(await client.config("sensei-cn"), "/lesson_times", {
    staticData: await client.staticData(),
  })!;
  const rows = structuredClone(field.editorValue) as { count: number }[];
  rows[2].count = 7;
  await executeAction(
    "config_set",
    { path: field.path, value: parseConfigurationValue(field, rows) },
    context
  );
  expect((await client.config("sensei-cn")).lesson_times).toEqual([0, 1, 7]);
  expect(approvals[0]).toMatchObject({ before: [0], value: [0, 1, 7] });
  await executeAction(
    "config_set",
    {
      path: "/lesson_each_region_object_priority",
      value: [["advanced"], [], ["superior", "primary"]],
    },
    context
  );
  expect((await client.config("sensei-cn")).lesson_each_region_object_priority).toEqual([
    ["advanced"],
    [],
    ["superior", "primary"],
  ]);
  await expect(
    executeAction("config_set", { path: field.path, value: [0, 1, 100] }, context)
  ).rejects.toThrow();
  expect((await client.config("sensei-cn")).lesson_times).toEqual([0, 1, 7]);
  expect(approvals).toHaveLength(2);
});

test("saving an expanded lesson table does not overwrite a concurrent count change", async () => {
  const client = await lessonClient();
  const context: ActionContext = {
    client: async () => client,
    profile: "sensei-cn",
    readOnly: false,
    approve: async () => {
      await client.patchConfig("sensei-cn", "/lesson_times", [2]);
      return true;
    },
  };
  await expect(
    executeAction("config_set", { path: "/lesson_times", value: [0, 1, 7] }, context)
  ).rejects.toThrow("发生变化");
  expect((await client.config("sensei-cn")).lesson_times).toEqual([2]);
});
