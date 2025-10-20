import React, {useState, useMemo, useEffect} from "react";
import {useTranslation} from "react-i18next";
import {EllipsisWithTooltip} from "@/components/ui/etooltip.tsx";

// shadcn tabs
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import {FormInput} from "@/components/ui/FormInput.tsx";
import {DynamicConfig} from "@/types/dynamic";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {serverMap} from "@/lib/utils.ts";

type TabKey = "common" | "tactical";

interface Draft {
  CommonShopList: number[];
  CommonShopRefreshTime: number | string;
  TacticalChallengeShopList: number[];
  TacticalChallengeShopRefreshTime: number | string;
}

const ShopConfig: React.FC<{ profileId: string; onClose: () => void }> = ({
                                                                            profileId,
                                                                            onClose,
                                                                          }) => {
  const {t} = useTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings: Partial<DynamicConfig> = useWebSocketStore(
    (state) => state.configStore[profileId]
  );
  const modify = useWebSocketStore(state => state.modify);

  const serverType = serverMap[settings.server];

  const _default_goods_ =
    staticConfig.common_shop_price_list[serverType] as Array<
      [string, number, string]
    >;
  const _default_tactical_shop_goods_ =
    staticConfig.tactical_challenge_shop_price_list[serverType] as Array<
      [string, number, string]
    >;

  const shopDefs = {
    common: {
      title: t("commonShop.title"),
      listKey: "CommonShopList",
      refreshKey: "CommonShopRefreshTime",
      defaultGoods: _default_goods_,
    },
    tactical: {
      title: t("tacticalShop.title"),
      listKey: "TacticalChallengeShopList",
      refreshKey: "TacticalChallengeShopRefreshTime",
      defaultGoods: _default_tactical_shop_goods_,
    },
  } as const;

  const [activeTab, setActiveTab] = useState<TabKey>("common");

  /** ext = Snapshot */
  const ext = useMemo(() => {
    return {
      CommonShopList:
        settings.CommonShopList ||
        Array(shopDefs.common.defaultGoods.length).fill(0),
      CommonShopRefreshTime: settings.CommonShopRefreshTime ?? 0,
      TacticalChallengeShopList:
        settings.TacticalChallengeShopList ||
        Array(shopDefs.tactical.defaultGoods.length).fill(0),
      TacticalChallengeShopRefreshTime:
        settings.TacticalChallengeShopRefreshTime ?? 0,
    };
  }, [settings]);

  /** draft = 本地编辑状态 */
  const [draft, setDraft] = useState<Draft>(ext);

  /** 保证外部更新时同步 draft */
  useEffect(() => {
    setDraft(ext);
  }, [ext]);

  /** 脏检查 */
  const dirty = JSON.stringify(draft) !== JSON.stringify(ext);

  /** 切换商品启用/禁用 */
  const toggleItem = (tab: TabKey, i: number) => {
    setDraft((d) => {
      const list =
        tab === "common" ? [...d.CommonShopList] : [...d.TacticalChallengeShopList];
      list[i] = list[i] === 1 ? 0 : 1;
      return tab === "common"
        ? {...d, CommonShopList: list}
        : {...d, TacticalChallengeShopList: list};
    });
  };

  /** 修改刷新次数 */
  const handleRefreshChange = (tab: TabKey, e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    if (raw === "") {
      setDraft((d) =>
        tab === "common"
          ? {...d, CommonShopRefreshTime: ""}
          : {...d, TacticalChallengeShopRefreshTime: ""}
      );
      return;
    }
    const n = Number(raw);
    if (Number.isFinite(n)) {
      setDraft((d) =>
        tab === "common"
          ? {...d, CommonShopRefreshTime: Math.max(0, Math.min(n, 5))}
          : {...d, TacticalChallengeShopRefreshTime: Math.max(0, Math.min(n, 5))}
      );
    }
  };

  /** Save */
  const handleSave = async () => {
    if (!dirty) {
      onClose();
      return;
    }
    const patch: Partial<DynamicConfig> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (draft[k] !== ext[k]) {
        patch[k] = draft[k] as any;
      }
    });
    modify(`${profileId}::config`, patch)

    onClose();
  };

  return (
    <div className="space-y-6">
      <Tabs
        defaultValue="common"
        value={activeTab}
        onValueChange={(val) => setActiveTab(val as TabKey)}
      >
        <TabsList className="grid grid-cols-2 w-full">
          <TabsTrigger value="common">{shopDefs.common.title}</TabsTrigger>
          <TabsTrigger value="tactical">{shopDefs.tactical.title}</TabsTrigger>
        </TabsList>

        {(["common", "tactical"] as TabKey[]).map((tab) => {
          const def = shopDefs[tab];
          return (
            <TabsContent key={tab} value={tab} className="space-y-2">
              {/* 刷新次数 */}
              <div className="flex items-center justify-between p-4 bg-slate-50 dark:bg-slate-700/50 rounded-lg">
                <div>
                  <label className="text-slate-700 dark:text-slate-200 font-medium">
                    {t("commonShop.refreshTimes")}
                  </label>
                  <p className="text-sm text-slate-500 dark:text-slate-400">
                    {t("commonShop.refreshDesc")}
                  </p>
                </div>
                <FormInput
                  type="number"
                  min={0}
                  max={5}
                  value={
                    tab === "common"
                      ? draft.CommonShopRefreshTime
                      : draft.TacticalChallengeShopRefreshTime
                  }
                  onChange={(e) => handleRefreshChange(tab, e)}
                  className="w-20"
                />
              </div>

              {/* 商品列表 */}
              <div className="max-h-[40vh] overflow-y-auto pr-1 grid grid-cols-2 gap-1">
                {def.defaultGoods.map(([nameKey, price, coin], i) => {
                  const enabled =
                    (tab === "common"
                      ? draft.CommonShopList
                      : draft.TacticalChallengeShopList)[i] === 1;
                  const priceText =
                    coin === "creditpoints"
                      ? `${price} ${t("creditpoints")}`
                      : `${price} ${t("pyroxene")}`;

                  return (
                    <div
                      key={`${nameKey}-${i}`}
                      className={`${
                        enabled
                          ? "bg-primary-600 text-white hover:bg-primary-700"
                          : "bg-slate-200 text-slate-800 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"
                      } p-2 rounded-lg cursor-pointer`}
                      onClick={() => toggleItem(tab, i)}
                    >
                      <div>
                        <EllipsisWithTooltip text={nameKey}/>
                        <div
                          className={`text-sm ${
                            enabled
                              ? "text-slate-200"
                              : "text-slate-500 dark:text-slate-400"
                          }`}
                        >
                          {priceText}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </TabsContent>
          );
        })}
      </Tabs>

      {/* Save Button */}
      <div className="flex justify-end pt-4 border-t border-slate-200 dark:border-slate-700">
        <button
          onClick={handleSave}
          disabled={!dirty}
          className="px-6 py-2 bg-primary-600 text-white font-semibold rounded-lg hover:bg-primary-700 disabled:opacity-60"
        >
          {t("save")}
        </button>
      </div>
    </div>
  );
};

export default ShopConfig;
