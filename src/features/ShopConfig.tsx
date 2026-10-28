import React, { useMemo, useState } from "react";
import { Check } from "lucide-react";
import { useAppTranslation } from "@/shared/useAppTranslation";
import {
  ConfigurationGroup,
  ConfigurationInput,
} from "@/components/configuration/ConfigurationControls";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/Tabs";
import { useWebSocketStore } from "@/store/WebsocketStore";
import { serverMap } from "@/shared/GlobalUtilities";
import { useConfigurationDraft } from "@/shared/useConfigurationDraft";
import { toggleShopSlot } from "@/shared/ShopSelection";
import "./shop-config.css";

type TabKey = "common" | "tactical";
type ShopCurrency = "creditpoints" | "pyroxene" | "tactical_challenge_coin" | "bounty_coin";
type Goods = [string, number, string?];
interface Draft {
  CommonShopList: number[];
  CommonShopRefreshTime: number | string;
  TacticalChallengeShopList: number[];
  TacticalChallengeShopRefreshTime: number | string;
}
const serialize = (draft: Draft) =>
  draft.CommonShopRefreshTime === "" || draft.TacticalChallengeShopRefreshTime === ""
    ? null
    : { ...draft };

/** Item positions follow the game's four-column shop; selection remains an ordered 0/1 array. */
const ShopConfig: React.FC<{ profileId: string; onClose: () => void }> = ({ profileId }) => {
  const { t } = useAppTranslation();
  const staticConfig = useWebSocketStore((state) => state.staticStore);
  const settings = useWebSocketStore((state) => state.configStore[profileId]);
  const server = serverMap[settings.server];
  const commonGoods: Goods[] = staticConfig.common_shop_price_list?.[server] ?? [];
  const tacticalGoods: Goods[] = staticConfig.tactical_challenge_shop_price_list?.[server] ?? [];
  const definitions = {
    common: {
      title: t("commonShop.title"),
      listKey: "CommonShopList",
      refreshKey: "CommonShopRefreshTime",
      goods: commonGoods,
    },
    tactical: {
      title: t("tacticalShop.title"),
      listKey: "TacticalChallengeShopList",
      refreshKey: "TacticalChallengeShopRefreshTime",
      goods: tacticalGoods,
    },
  } as const;
  const currencyNames: Record<ShopCurrency, string> = {
    creditpoints: t("property.credits"),
    pyroxene: t("property.pyroxene"),
    tactical_challenge_coin: t("property.coin.arena"),
    bounty_coin: t("property.coin.commission"),
  };
  const ext = useMemo<Draft>(
    () => ({
      CommonShopList: settings.CommonShopList ?? Array(commonGoods.length).fill(0),
      CommonShopRefreshTime: settings.CommonShopRefreshTime ?? 0,
      TacticalChallengeShopList:
        settings.TacticalChallengeShopList ?? Array(tacticalGoods.length).fill(0),
      TacticalChallengeShopRefreshTime: settings.TacticalChallengeShopRefreshTime ?? 0,
    }),
    [settings, commonGoods.length, tacticalGoods.length]
  );
  const [draft, setDraft] = useConfigurationDraft(profileId, "shop", ext, { serialize });
  const [tab, setTab] = useState<TabKey>("common");
  return (
    <Tabs
      value={tab}
      onValueChange={(value) => setTab(value as TabKey)}
      className="shop-config space-y-6"
    >
      <TabsList className="grid w-full grid-cols-2">
        <TabsTrigger value="common">{definitions.common.title}</TabsTrigger>
        <TabsTrigger value="tactical">{definitions.tactical.title}</TabsTrigger>
      </TabsList>
      {(["common", "tactical"] as const).map((key) => {
        const definition = definitions[key];
        return (
          <TabsContent key={key} value={key}>
            <ConfigurationGroup title={definition.title}>
              <ConfigurationInput
                label={t("commonShop.refreshTimes")}
                description={t("description.commonShop.refresh")}
                type="number"
                min={0}
                max={5}
                value={draft[definition.refreshKey]}
                onChange={(event) => {
                  const value = event.target.value;
                  if (value === "" || Number.isFinite(Number(value)))
                    setDraft((current) => ({
                      ...current,
                      [definition.refreshKey]:
                        value === "" ? "" : Math.max(0, Math.min(5, Math.trunc(Number(value)))),
                    }));
                }}
              />
              <div className="shop-goods-grid" role="group" aria-label={definition.title}>
                {definition.goods.map(([name, price, rawCurrency], index) => {
                  const currency = rawCurrency ?? "tactical_challenge_coin";
                  const enabled = draft[definition.listKey][index] === 1;
                  return (
                    <button
                      type="button"
                      key={`${name}:${index}`}
                      className="shop-goods-item"
                      aria-pressed={enabled}
                      aria-label={`${name}: ${price} ${currencyNames[currency as ShopCurrency] ?? currency}`}
                      onClick={() =>
                        setDraft((current) => {
                          return {
                            ...current,
                            [definition.listKey]: toggleShopSlot(
                              current[definition.listKey],
                              index
                            ),
                          };
                        })
                      }
                    >
                      <span className="shop-goods-heading">
                        <span className="shop-goods-name">{name}</span>
                        <span className="shop-goods-selected" aria-hidden="true">
                          {enabled && <Check size={12} strokeWidth={2.5} />}
                        </span>
                      </span>
                      <span className="shop-goods-price">
                        <span>{price.toLocaleString()}</span>
                        <span>{currencyNames[currency as ShopCurrency] ?? currency}</span>
                      </span>
                    </button>
                  );
                })}
              </div>
            </ConfigurationGroup>
          </TabsContent>
        );
      })}
    </Tabs>
  );
};
export default ShopConfig;
