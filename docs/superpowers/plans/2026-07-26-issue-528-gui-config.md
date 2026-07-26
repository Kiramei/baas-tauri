# Issue #528 GUI Configuration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete desktop and Android GUI controls for the six unrestricted-decisive-battle and friend-cleanup settings requested by Issue #528.

**Architecture:** Put normalization, integer-boundary handling, method switching, and minimal patch generation in a small shared TypeScript module. The new unrestricted-decisive-battle panel and the extended friend-cleanup panel consume that module and persist through the existing Zustand `modify(\`${profileId}::config\`, patch)` boundary. Both desktop and Android configuration registries expose the same shared panels.

**Tech Stack:** React 19, TypeScript 5.8, Zustand, Radix Select, Tailwind CSS, i18next, Bun test runner, Vite 8, Tauri 2.

## Global Constraints

- Work only on `feat/issue-528-gui-config`, based on `dev@711a09d4`.
- Store exactly the six keys and defaults listed in Issue #528.
- Offer only `default` and `copy_clear_unit` as formation methods.
- Constrain unavailable students to integer `0–10`.
- Constrain clear-team refreshes to integers greater than or equal to `0`.
- Constrain all three friend-cleanup thresholds to integers greater than or equal to `-1`; `-1` disables the condition.
- Keep copy-clear fields visible but disabled outside `copy_clear_unit`, without erasing their values.
- Keep whitelist and friend-cleanup thresholds in one panel.
- Do not change the backend protocol, scheduler, Python behavior, or unrelated configuration cards.
- Keep all seven locales (`de`, `en`, `fr`, `ja`, `ko`, `ru`, `zh`) synchronized and non-placeholder.
- Follow strict red-green-refactor: every production behavior starts with a test that fails for the expected missing behavior.

---

## File Structure

- Create `src/features/issue528Config.ts`: pure configuration normalization, boundary parsing, method switching, and minimal patch generation.
- Create `tests/frontend/Issue528Config.test.ts`: behavior-level tests for the shared configuration module.
- Modify `src/types/dynamic.d.ts`: add the six backend configuration fields.
- Create `src/features/FinalRestrictionRlsConfig.tsx`: unrestricted decisive battle form and save flow.
- Modify `src/features/WhiteListConfig.tsx`: combine whitelist editing with three friend-cleanup thresholds.
- Modify `src/pages/ConfigurationPage.tsx`: register the new desktop card.
- Modify `src/android/pages/ConfigurationPage.tsx`: lazy-register the same card for Android.
- Modify `src/shared/I18nKeys.ts` and `scripts/i18n-allowlist.json`: type the new dynamic card keys.
- Modify `scripts/i18n.mjs`: seed translations for newly introduced static keys.
- Regenerate `public/locales/{de,en,fr,ja,ko,ru,zh}.json`, `src/types/i18n.ts`, and `src/types/i18next.d.ts` with `bun run i18n:sync`.

---

### Task 1: Shared Issue #528 Configuration Model

**Files:**

- Create: `tests/frontend/Issue528Config.test.ts`
- Create: `src/features/issue528Config.ts`
- Modify: `src/types/dynamic.d.ts:85-89`

**Interfaces:**

- Produces:
  - `FinalRestrictionFormationMethod`
  - `FinalRestrictionDraft`
  - `FriendCleanupDraft`
  - `normalizeFinalRestrictionConfig(settings)`
  - `normalizeFriendCleanupConfig(settings)`
  - `parseBoundedInteger(value, min, max?)`
  - `withFormationMethod(draft, method)`
  - `isCopyClearUnit(method)`
  - `createFinalRestrictionPatch(current, draft)`
  - `createFriendCleanupPatch(current, draft)`
- Consumes: `Partial<DynamicConfig>`.

- [ ] **Step 1: Write the failing behavior tests**

Create `tests/frontend/Issue528Config.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import {
  createFinalRestrictionPatch,
  createFriendCleanupPatch,
  isCopyClearUnit,
  normalizeFinalRestrictionConfig,
  normalizeFriendCleanupConfig,
  parseBoundedInteger,
  withFormationMethod,
} from "../../src/features/issue528Config";

describe("Issue #528 configuration model", () => {
  test("normalizes missing unrestricted battle settings to backend defaults", () => {
    expect(normalizeFinalRestrictionConfig({})).toEqual({
      formationMethod: "default",
      maxUnavailableStudentCount: 0,
      maxRefreshCount: 10,
    });
  });

  test("enables copy-clear controls only for the copy_clear_unit method", () => {
    expect(isCopyClearUnit("default")).toBe(false);
    expect(isCopyClearUnit("copy_clear_unit")).toBe(true);
  });

  test("switching formation method preserves both copy-clear values", () => {
    const draft = {
      formationMethod: "copy_clear_unit" as const,
      maxUnavailableStudentCount: 4,
      maxRefreshCount: 12,
    };

    expect(withFormationMethod(draft, "default")).toEqual({
      formationMethod: "default",
      maxUnavailableStudentCount: 4,
      maxRefreshCount: 12,
    });
  });

  test("accepts only integers inside the requested boundaries", () => {
    expect(parseBoundedInteger("0", 0, 10)).toBe(0);
    expect(parseBoundedInteger("10", 0, 10)).toBe(10);
    expect(parseBoundedInteger("-1", -1)).toBe(-1);
    expect(parseBoundedInteger("-1", 0, 10)).toBeNull();
    expect(parseBoundedInteger("11", 0, 10)).toBeNull();
    expect(parseBoundedInteger("1.5", 0)).toBeNull();
    expect(parseBoundedInteger("", -1)).toBeNull();
  });

  test("emits only changed unrestricted battle keys", () => {
    const current = normalizeFinalRestrictionConfig({});
    const draft = { ...current, formationMethod: "copy_clear_unit" as const };

    expect(createFinalRestrictionPatch(current, draft)).toEqual({
      final_restriction_rls_employ_formation_method: "copy_clear_unit",
    });
  });

  test("normalizes old friend profiles and saves whitelist plus thresholds together", () => {
    const current = normalizeFriendCleanupConfig({ clear_friend_white_list: ["OLD"] });
    expect(current).toEqual({
      clearFriendWhiteList: ["OLD"],
      levelLimit: -1,
      lastLoginDays: -1,
      lastTotalAssaultRankLimit: -1,
    });

    expect(
      createFriendCleanupPatch(current, {
        ...current,
        clearFriendWhiteList: ["OLD", "NEW"],
        levelLimit: 80,
        lastLoginDays: 30,
      })
    ).toEqual({
      clear_friend_white_list: ["OLD", "NEW"],
      clear_friend_level_limit: 80,
      clear_friend_last_login_time_days: 30,
    });
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
bun test tests/frontend/Issue528Config.test.ts
```

Expected: FAIL because `src/features/issue528Config.ts` does not exist. This proves the test is exercising the missing production boundary rather than an existing behavior.

- [ ] **Step 3: Add exact backend field types**

Add these fields next to `clear_friend_white_list` and the nearby task settings in `src/types/dynamic.d.ts`:

```ts
final_restriction_rls_employ_formation_method: "default" | "copy_clear_unit";
final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count: number;
final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count: number;
clear_friend_white_list: string[];
clear_friend_level_limit: number;
clear_friend_last_login_time_days: number;
clear_friend_last_total_assault_rank_limit: number;
```

- [ ] **Step 4: Implement the minimal shared model**

Create `src/features/issue528Config.ts`:

```ts
import type { DynamicConfig } from "@/types/dynamic";

export type FinalRestrictionFormationMethod = "default" | "copy_clear_unit";

export interface FinalRestrictionDraft {
  formationMethod: FinalRestrictionFormationMethod;
  maxUnavailableStudentCount: number;
  maxRefreshCount: number;
}

export interface FriendCleanupDraft {
  clearFriendWhiteList: string[];
  levelLimit: number;
  lastLoginDays: number;
  lastTotalAssaultRankLimit: number;
}

export const parseBoundedInteger = (value: string, min: number, max?: number): number | null => {
  if (value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || (max !== undefined && parsed > max)) {
    return null;
  }
  return parsed;
};

const boundedOrDefault = (value: unknown, fallback: number, min: number, max?: number): number => {
  const parsed = typeof value === "number" ? parseBoundedInteger(String(value), min, max) : null;
  return parsed ?? fallback;
};

export const normalizeFinalRestrictionConfig = (
  settings: Partial<DynamicConfig>
): FinalRestrictionDraft => ({
  formationMethod:
    settings.final_restriction_rls_employ_formation_method === "copy_clear_unit"
      ? "copy_clear_unit"
      : "default",
  maxUnavailableStudentCount: boundedOrDefault(
    settings.final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count,
    0,
    0,
    10
  ),
  maxRefreshCount: boundedOrDefault(
    settings.final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count,
    10,
    0
  ),
});

export const normalizeFriendCleanupConfig = (
  settings: Partial<DynamicConfig>
): FriendCleanupDraft => ({
  clearFriendWhiteList: Array.isArray(settings.clear_friend_white_list)
    ? [...settings.clear_friend_white_list]
    : [],
  levelLimit: boundedOrDefault(settings.clear_friend_level_limit, -1, -1),
  lastLoginDays: boundedOrDefault(settings.clear_friend_last_login_time_days, -1, -1),
  lastTotalAssaultRankLimit: boundedOrDefault(
    settings.clear_friend_last_total_assault_rank_limit,
    -1,
    -1
  ),
});

export const isCopyClearUnit = (method: FinalRestrictionFormationMethod): boolean =>
  method === "copy_clear_unit";

export const withFormationMethod = (
  draft: FinalRestrictionDraft,
  formationMethod: FinalRestrictionFormationMethod
): FinalRestrictionDraft => ({ ...draft, formationMethod });

export const createFinalRestrictionPatch = (
  current: FinalRestrictionDraft,
  draft: FinalRestrictionDraft
): Partial<DynamicConfig> => {
  const patch: Partial<DynamicConfig> = {};
  if (draft.formationMethod !== current.formationMethod) {
    patch.final_restriction_rls_employ_formation_method = draft.formationMethod;
  }
  if (draft.maxUnavailableStudentCount !== current.maxUnavailableStudentCount) {
    patch.final_restriction_rls_employ_formation_copy_clear_unit_max_unavailable_student_count =
      draft.maxUnavailableStudentCount;
  }
  if (draft.maxRefreshCount !== current.maxRefreshCount) {
    patch.final_restriction_rls_employ_formation_copy_clear_unit_max_refresh_count =
      draft.maxRefreshCount;
  }
  return patch;
};

export const createFriendCleanupPatch = (
  current: FriendCleanupDraft,
  draft: FriendCleanupDraft
): Partial<DynamicConfig> => {
  const patch: Partial<DynamicConfig> = {};
  if (JSON.stringify(draft.clearFriendWhiteList) !== JSON.stringify(current.clearFriendWhiteList)) {
    patch.clear_friend_white_list = draft.clearFriendWhiteList;
  }
  if (draft.levelLimit !== current.levelLimit) {
    patch.clear_friend_level_limit = draft.levelLimit;
  }
  if (draft.lastLoginDays !== current.lastLoginDays) {
    patch.clear_friend_last_login_time_days = draft.lastLoginDays;
  }
  if (draft.lastTotalAssaultRankLimit !== current.lastTotalAssaultRankLimit) {
    patch.clear_friend_last_total_assault_rank_limit = draft.lastTotalAssaultRankLimit;
  }
  return patch;
};
```

- [ ] **Step 5: Run focused and full frontend tests and verify GREEN**

Run:

```powershell
bun test tests/frontend/Issue528Config.test.ts
bun test tests/frontend
```

Expected: the new six behavior tests pass; the existing six frontend tests also remain green.

- [ ] **Step 6: Format, inspect, and commit**

Run:

```powershell
bunx prettier --write src/types/dynamic.d.ts src/features/issue528Config.ts tests/frontend/Issue528Config.test.ts
bunx prettier --check src/types/dynamic.d.ts src/features/issue528Config.ts tests/frontend/Issue528Config.test.ts
git diff --check
git add src/types/dynamic.d.ts src/features/issue528Config.ts tests/frontend/Issue528Config.test.ts
git commit -m "feat: add issue 528 config model"
```

---

### Task 2: Unrestricted Decisive Battle Panel

**Files:**

- Create: `src/features/FinalRestrictionRlsConfig.tsx`
- Modify: `src/pages/ConfigurationPage.tsx:1-203`
- Modify: `src/android/pages/ConfigurationPage.tsx:1-185`
- Modify: `src/shared/I18nKeys.ts:123-158`
- Modify: `scripts/i18n-allowlist.json`
- Modify: `scripts/i18n.mjs:147-623`
- Regenerate: `public/locales/{de,en,fr,ja,ko,ru,zh}.json`
- Regenerate: `src/types/i18n.ts`
- Regenerate: `src/types/i18next.d.ts`

**Interfaces:**

- Consumes all `FinalRestrictionDraft` helpers from Task 1.
- Produces a shared `FinalRestrictionRlsConfig` panel registered under feature id `finalRestrictionRls`.

- [ ] **Step 1: Reproduce the missing GUI entry (RED)**

Start the current frontend and open a profile's configuration page before changing either registry:

```powershell
bun run dev:tauri -- --host 127.0.0.1
```

Expected: no “无限制决战” card exists and therefore no GUI path can edit the three unrestricted decisive battle keys. Record this browser observation, then stop the server.

- [ ] **Step 2: Verify the focused model test is green before wiring UI**

Run:

```powershell
bun test tests/frontend/Issue528Config.test.ts
```

Expected: PASS. If it fails, stop and repair Task 1 before adding UI.

- [ ] **Step 3: Add exact translations and typed dynamic keys**

Add `finalRestrictionRls` and `description.finalRestrictionRls` to the feature map in `src/shared/I18nKeys.ts`:

```ts
finalRestrictionRls: "finalRestrictionRls",
finalRestrictionRlsDesc: "description.finalRestrictionRls",
```

Add the same two translation keys to `scripts/i18n-allowlist.json`.

Add these exact localized values to the corresponding language blocks in `scripts/i18n.mjs`:

| Key                                              | zh                                     | en                                                          | de                                                                       | fr                                                                          | ja                                           | ko                                                | ru                                                                      |
| ------------------------------------------------ | -------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------ | --------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------- | ----------------------------------------------------------------------- |
| `finalRestrictionRls`                            | 无限制决战                             | Unrestricted Decisive Battle                                | Entscheidungskampf ohne Beschränkung                                     | Combat décisif sans restriction                                             | 制限解除決戦                                 | 제한 해제 결전                                    | Решающий бой без ограничений                                            |
| `description.finalRestrictionRls`                | 配置编队方式与通关队伍复制             | Configure formation and clear-team copying                  | Formation und Kopieren erfolgreicher Teams konfigurieren                 | Configurer la formation et la copie des équipes victorieuses                | 編成方法とクリア編成のコピーを設定           | 편성 방식과 클리어 편성 복사를 설정               | Настройка построения и копирования прошедших команд                     |
| `finalRestrictionRls.formationMethod`            | 编队方式                               | Formation method                                            | Formationsmethode                                                        | Méthode de formation                                                        | 編成方法                                     | 편성 방식                                         | Способ построения                                                       |
| `finalRestrictionRls.useCurrentFormation`        | 使用当前编队                           | Use current formation                                       | Aktuelle Formation verwenden                                             | Utiliser la formation actuelle                                              | 現在の編成を使用                             | 현재 편성 사용                                    | Использовать текущую команду                                            |
| `finalRestrictionRls.copyClearFormation`         | 复制通关队伍                           | Copy a clear formation                                      | Erfolgreiches Team kopieren                                              | Copier une équipe victorieuse                                               | クリア編成をコピー                           | 클리어 편성 복사                                  | Копировать прошедшую команду                                            |
| `finalRestrictionRls.maxUnavailableStudentCount` | 最多允许不可用学生数                   | Maximum unavailable students                                | Maximal nicht verfügbare Schüler                                         | Nombre maximal d'élèves indisponibles                                       | 使用不可生徒の最大数                         | 사용 불가 학생 최대 수                            | Максимум недоступных учениц                                             |
| `finalRestrictionRls.maxRefreshCount`            | 通关队伍最大刷新次数                   | Maximum clear-team refreshes                                | Maximale Aktualisierungen erfolgreicher Teams                            | Actualisations maximales des équipes victorieuses                           | クリア編成の最大更新回数                     | 클리어 편성 최대 새로고침 횟수                    | Максимум обновлений прошедших команд                                    |
| `finalRestrictionRls.copyClearUnavailableHint`   | 选择“复制通关队伍”后可配置这两个选项。 | Select “Copy a clear formation” to configure these options. | Wähle „Erfolgreiches Team kopieren“, um diese Optionen zu konfigurieren. | Sélectionnez « Copier une équipe victorieuse » pour configurer ces options. | 「クリア編成をコピー」を選ぶと設定できます。 | “클리어 편성 복사”를 선택하면 설정할 수 있습니다. | Выберите «Копировать прошедшую команду», чтобы настроить эти параметры. |

Run:

```powershell
bun run i18n:sync
bun run i18n:check
```

Expected: generated locale files and translation types include all eight new keys; validation reports seven synchronized locales.

- [ ] **Step 4: Create the unrestricted decisive battle panel**

Create `src/features/FinalRestrictionRlsConfig.tsx` using the following behavior:

```tsx
import React, { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormInput } from "@/components/ui/FormInput";
import { FormSelect } from "@/components/ui/FormSelect";
import { useWebSocketStore } from "@/store/WebsocketStore";
import type { DynamicConfig } from "@/types/dynamic";
import {
  createFinalRestrictionPatch,
  isCopyClearUnit,
  normalizeFinalRestrictionConfig,
  parseBoundedInteger,
  type FinalRestrictionFormationMethod,
  withFormationMethod,
} from "@/features/issue528Config";

interface FinalRestrictionRlsConfigProps {
  profileId: string;
  onClose: () => void;
}

const FinalRestrictionRlsConfig: React.FC<FinalRestrictionRlsConfigProps> = ({
  profileId,
  onClose,
}) => {
  const { t } = useTranslation();
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId]
  );
  const modify = useWebSocketStore((state) => state.modify);
  const current = useMemo(() => normalizeFinalRestrictionConfig(settings), [settings]);
  const [draft, setDraft] = useState(current);
  const copyClearEnabled = isCopyClearUnit(draft.formationMethod);
  const dirty = JSON.stringify(draft) !== JSON.stringify(current);

  const handleMethodChange = (value: string) => {
    setDraft((previous) => withFormationMethod(previous, value as FinalRestrictionFormationMethod));
  };

  const handleNumberChange =
    (field: "maxUnavailableStudentCount" | "maxRefreshCount") =>
    (event: React.ChangeEvent<HTMLInputElement>) => {
      const parsed =
        field === "maxUnavailableStudentCount"
          ? parseBoundedInteger(event.target.value, 0, 10)
          : parseBoundedInteger(event.target.value, 0);
      if (parsed !== null) setDraft((previous) => ({ ...previous, [field]: parsed }));
    };

  const handleSave = () => {
    const patch = createFinalRestrictionPatch(current, draft);
    if (Object.keys(patch).length > 0) modify(`${profileId}::config`, patch);
    onClose();
  };

  return (
    <div className="space-y-6">
      <FormSelect
        label={t("finalRestrictionRls.formationMethod")}
        value={draft.formationMethod}
        onChange={handleMethodChange}
        options={[
          { value: "default", label: t("finalRestrictionRls.useCurrentFormation") },
          { value: "copy_clear_unit", label: t("finalRestrictionRls.copyClearFormation") },
        ]}
      />
      <div className="space-y-3">
        <FormInput
          type="number"
          min={0}
          max={10}
          disabled={!copyClearEnabled}
          label={t("finalRestrictionRls.maxUnavailableStudentCount")}
          value={draft.maxUnavailableStudentCount}
          onChange={handleNumberChange("maxUnavailableStudentCount")}
        />
        <FormInput
          type="number"
          min={0}
          disabled={!copyClearEnabled}
          label={t("finalRestrictionRls.maxRefreshCount")}
          value={draft.maxRefreshCount}
          onChange={handleNumberChange("maxRefreshCount")}
        />
        {!copyClearEnabled && (
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {t("finalRestrictionRls.copyClearUnavailableHint")}
          </p>
        )}
      </div>
      <div className="flex justify-end border-t border-slate-200 pt-4 dark:border-slate-700">
        <button
          type="button"
          onClick={handleSave}
          disabled={!dirty}
          className="rounded-lg bg-primary-600 px-6 py-2 font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
        >
          {t("common.save")}
        </button>
      </div>
    </div>
  );
};

export default FinalRestrictionRlsConfig;
```

- [ ] **Step 5: Register the shared panel in desktop and Android**

In both configuration pages:

- add `"finalRestrictionRls"` to `Feature`;
- set `FeatureWidthDict.finalRestrictionRls` to `45`;
- use the Lucide `Trophy` icon;
- map description key `description.finalRestrictionRls`;
- place the card after `tactical` in the feature-settings group.

Desktop imports `FinalRestrictionRlsConfig` directly. Android declares:

```ts
const FinalRestrictionRlsConfig = React.lazy(() => import("@/features/FinalRestrictionRlsConfig"));
```

- [ ] **Step 6: Verify the panel compiles on both frontend targets**

Run:

```powershell
bun run i18n:check
bun run build:tauri
bun run build:tauri:android
```

Expected: both builds exit `0`; the Android lazy import resolves the same panel.

- [ ] **Step 7: Format, inspect, and commit**

Run:

```powershell
bunx prettier --write src/features/FinalRestrictionRlsConfig.tsx src/pages/ConfigurationPage.tsx src/android/pages/ConfigurationPage.tsx src/shared/I18nKeys.ts scripts/i18n-allowlist.json scripts/i18n.mjs public/locales src/types/i18n.ts src/types/i18next.d.ts
bun run i18n:check
git diff --check
git add src/features/FinalRestrictionRlsConfig.tsx src/pages/ConfigurationPage.tsx src/android/pages/ConfigurationPage.tsx src/shared/I18nKeys.ts scripts/i18n-allowlist.json scripts/i18n.mjs public/locales src/types/i18n.ts src/types/i18next.d.ts
git commit -m "feat: add unrestricted decisive battle settings"
```

---

### Task 3: Friend Cleanup Thresholds

**Files:**

- Modify: `src/features/WhiteListConfig.tsx`
- Modify: `scripts/i18n.mjs`
- Modify: `public/locales/{de,en,fr,ja,ko,ru,zh}.json`
- Regenerate: `src/types/i18n.ts`
- Regenerate: `src/types/i18next.d.ts`

**Interfaces:**

- Consumes `normalizeFriendCleanupConfig`, `parseBoundedInteger`, and `createFriendCleanupPatch` from Task 1.
- Produces one save patch that may contain whitelist changes and any subset of the three thresholds.

- [ ] **Step 1: Reproduce the missing friend-filter controls (RED)**

Start the current frontend and open the existing friend whitelist modal before editing it:

```powershell
bun run dev:tauri -- --host 127.0.0.1
```

Expected: the modal exposes only whitelist add/remove behavior; the three requested threshold labels and `-1` explanation are absent. Record this browser observation, then stop the server. The friend normalization and combined-patch tests from Task 1 already failed before their production helpers were created and remain the automated regression coverage.

- [ ] **Step 2: Add exact friend-cleanup translations**

Add the following keys to every language block in `scripts/i18n.mjs`, then update the existing `whitelist` and `description.whitelist` values in each generated locale:

| Key                                | zh                           | en                                             | de                                            | fr                                          | ja                                    | ko                                        | ru                                                   |
| ---------------------------------- | ---------------------------- | ---------------------------------------------- | --------------------------------------------- | ------------------------------------------- | ------------------------------------- | ----------------------------------------- | ---------------------------------------------------- |
| `whitelist`                        | 好友清理                     | Friend cleanup                                 | Freunde bereinigen                            | Nettoyage des amis                          | フレンド整理                          | 친구 정리                                 | Очистка друзей                                       |
| `description.whitelist`            | 配置清理条件与好友白名单     | Configure cleanup filters and friend whitelist | Filter und Freundes-Whitelist konfigurieren   | Configurer les filtres et la liste blanche  | 整理条件とフレンド白リストを設定      | 정리 조건과 친구 화이트리스트 설정        | Настройка фильтров и белого списка друзей            |
| `friend.filters`                   | 清理条件                     | Cleanup filters                                | Bereinigungsfilter                            | Filtres de nettoyage                        | 整理条件                              | 정리 조건                                 | Фильтры очистки                                      |
| `friend.levelLimit`                | 好友等级清理阈值             | Friend level threshold                         | Schwellenwert für Freundeslevel               | Seuil de niveau des amis                    | フレンドレベルしきい値                | 친구 레벨 임계값                          | Порог уровня друга                                   |
| `friend.lastLoginDays`             | 最后登录天数阈值             | Last-login days threshold                      | Schwellenwert seit letzter Anmeldung          | Seuil de jours depuis la dernière connexion | 最終ログイン日数しきい値              | 마지막 로그인 일수 임계값                 | Порог дней с последнего входа                        |
| `friend.lastTotalAssaultRankLimit` | 上次总力战排名阈值           | Previous total-assault rank threshold          | Schwellenwert des letzten Gesamtangriffsrangs | Seuil du classement du dernier assaut total | 前回総力戦順位しきい値                | 이전 총력전 순위 임계값                   | Порог места в прошлом тотальном штурме               |
| `friend.disabledThresholdHint`     | 输入 -1 可禁用对应清理条件。 | Enter -1 to disable a cleanup condition.       | Mit -1 wird der jeweilige Filter deaktiviert. | Saisissez -1 pour désactiver un filtre.     | -1 を入力すると条件を無効にできます。 | -1을 입력하면 해당 조건이 비활성화됩니다. | Введите -1, чтобы отключить соответствующее условие. |
| `friend.whitelist`                 | 好友白名单                   | Friend whitelist                               | Freundes-Whitelist                            | Liste blanche des amis                      | フレンド白リスト                      | 친구 화이트리스트                         | Белый список друзей                                  |

Run:

```powershell
bun run i18n:sync
bun run i18n:check
```

- [ ] **Step 3: Extend `WhiteListConfig` to one normalized draft**

Make `profileId` required. Replace the whitelist-only `ext` and draft with:

```ts
const current = useMemo(() => normalizeFriendCleanupConfig(settings), [settings]);
const [draft, setDraft] = useState(current);
const dirty = JSON.stringify(draft) !== JSON.stringify(current);
```

Update whitelist reads and writes to `draft.clearFriendWhiteList`.

Add a number-change handler that accepts only integers `>= -1`:

```ts
const handleThresholdChange =
  (field: "levelLimit" | "lastLoginDays" | "lastTotalAssaultRankLimit") =>
  (event: React.ChangeEvent<HTMLInputElement>) => {
    const parsed = parseBoundedInteger(event.target.value, -1);
    if (parsed !== null) setDraft((previous) => ({ ...previous, [field]: parsed }));
  };
```

Render the three `FormInput` controls above the whitelist area:

```tsx
<section className="space-y-3">
  <div>
    <h3 className="font-medium text-slate-700 dark:text-slate-200">{t("friend.filters")}</h3>
    <p className="text-sm text-slate-500 dark:text-slate-400">
      {t("friend.disabledThresholdHint")}
    </p>
  </div>
  <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
    <FormInput
      type="number"
      min={-1}
      label={t("friend.levelLimit")}
      value={draft.levelLimit}
      onChange={handleThresholdChange("levelLimit")}
    />
    <FormInput
      type="number"
      min={-1}
      label={t("friend.lastLoginDays")}
      value={draft.lastLoginDays}
      onChange={handleThresholdChange("lastLoginDays")}
    />
    <FormInput
      type="number"
      min={-1}
      label={t("friend.lastTotalAssaultRankLimit")}
      value={draft.lastTotalAssaultRankLimit}
      onChange={handleThresholdChange("lastTotalAssaultRankLimit")}
    />
  </div>
</section>
```

Add the `friend.whitelist` section heading above the existing add/list controls.

Replace the unconditional whitelist patch with:

```ts
const patch = createFriendCleanupPatch(current, draft);
if (Object.keys(patch).length > 0) modify(`${profileId}::config`, patch);
onClose();
```

- [ ] **Step 4: Verify tests, i18n, type checking, and both builds**

Run:

```powershell
bun test tests/frontend/Issue528Config.test.ts
bun test tests/frontend
bun run i18n:check
bun run lint
bun run build:tauri
bun run build:tauri:android
```

Expected: all commands exit `0`; the new test suite has seven passing Issue #528 tests.

- [ ] **Step 5: Format, inspect, and commit**

Run:

```powershell
bunx prettier --write src/features/WhiteListConfig.tsx tests/frontend/Issue528Config.test.ts scripts/i18n.mjs public/locales src/types/i18n.ts src/types/i18next.d.ts
bun run i18n:check
git diff --check
git add src/features/WhiteListConfig.tsx tests/frontend/Issue528Config.test.ts scripts/i18n.mjs public/locales src/types/i18n.ts src/types/i18next.d.ts
git commit -m "feat: add friend cleanup filters"
```

---

### Task 4: Rendered UI and Completion Audit

**Files:**

- Inspect all files changed since `dev`.
- Create and remove an ignored temporary preview harness under `.codex_tmp/issue-528-preview/` only if the normal development app cannot reach a profile configuration page without a backend.
- Do not commit the preview harness or screenshots.

**Interfaces:**

- Consumes the completed shared panels and generated locale bundle.
- Produces authoritative browser screenshots/inspection results and clean verification output.

- [ ] **Step 1: Start the real frontend**

Run:

```powershell
bun run dev:tauri -- --host 127.0.0.1
```

Use the in-app browser to open the reported local URL. Prefer the normal application route with a real or locally available profile. If backend availability prevents reaching configuration, build a temporary Vite entry under `.codex_tmp/issue-528-preview/` that initializes i18next in Chinese, seeds `useWebSocketStore.configStore.preview`, and renders the two real feature components; remove it after inspection.

- [ ] **Step 2: Verify desktop unrestricted decisive battle behavior**

At a desktop viewport:

1. Confirm the new card title and description are visible.
2. Open it and confirm `default` is selected for a profile without the keys.
3. Confirm both numeric fields show `0` and `10`, remain visible, and are disabled.
4. Select `copy_clear_unit`; confirm both fields enable.
5. Enter boundary values `10` and `0`.
6. Switch back to `default` and then to `copy_clear_unit`; confirm `10` and `0` remain.
7. Save and inspect the `modify` payload: it contains only changed backend keys.

- [ ] **Step 3: Verify friend cleanup behavior at desktop and narrow widths**

1. Confirm the existing card is titled “好友清理” with the new description.
2. Open it and confirm all three missing thresholds show `-1`.
3. Confirm the `-1` disabled explanation is visible.
4. Add a valid whitelist entry and change at least two thresholds.
5. Save and inspect the `modify` payload: whitelist and thresholds share one patch.
6. Repeat visual inspection at a narrow Android-sized viewport; confirm controls stack without clipping and the modal remains scrollable.

- [ ] **Step 4: Run the full fresh verification matrix**

Run:

```powershell
bun test tests/frontend
bun run lint
bun run build:tauri
bun run build:tauri:android
cargo test --workspace
bunx prettier --check src tests scripts public/locales docs/superpowers
git diff --check
git status --short --branch
git diff --stat dev...HEAD
git diff dev...HEAD
```

Required evidence:

- zero frontend test failures;
- i18n validation passes across seven locales;
- ESLint exits `0`;
- desktop and Android builds exit `0`;
- Rust workspace tests exit `0`;
- Prettier and whitespace checks pass;
- no temporary preview files remain;
- branch diff contains only Issue #528 implementation, its tests, generated translation artifacts, and the approved docs.

- [ ] **Step 5: Commit any verification-only formatting corrections**

Only if Task 4 changed tracked files, stage the complete scoped implementation set (unchanged paths are harmless):

```powershell
git add src/features/issue528Config.ts src/features/FinalRestrictionRlsConfig.tsx src/features/WhiteListConfig.tsx src/pages/ConfigurationPage.tsx src/android/pages/ConfigurationPage.tsx src/shared/I18nKeys.ts src/types/dynamic.d.ts src/types/i18n.ts src/types/i18next.d.ts tests/frontend/Issue528Config.test.ts scripts/i18n-allowlist.json scripts/i18n.mjs public/locales docs/superpowers
git commit -m "style: finalize issue 528 GUI configuration"
```

Do not create an empty commit.
