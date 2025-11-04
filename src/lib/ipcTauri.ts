import {invoke} from "@tauri-apps/api/core";
import {save, open} from "@tauri-apps/plugin-dialog";
import {TFunction} from "i18next";


/**
 * This part is used for file::*
 * Feature: File Related Operation.
 * */
export const exportLogForProfile = async (
  {
    translator,
    logContent,
    nameSaveTo
  }: {
    logContent: string,
    nameSaveTo: string,
    translator: TFunction
  }) => {
  const target = await save({
    title: translator("export.log.folderSelect"),
    defaultPath: nameSaveTo,
    filters: [{name: "Text File", extensions: ["txt"]}]
  });
  if (!target) return undefined;
  await invoke<void>("export_log_for_profile", {
    pathSaveTo: target,
    logToSave: logContent
  })
  return target;
}

export const getEmulatorPath = async (
  {
    translator,
  }: {
    translator: TFunction;
  }) => {
  const file = await open({
    title: translator("emulator.path.get"),
    multiple: false,
    filters: [
      {name: "Executable File", extensions: ["exe", "bin", "app", "*"]},
    ],
  });

  if (typeof file === "string") {
    return file;
  }
  return null;
};
