import React, {useState} from 'react';
import {useTranslation} from 'react-i18next';
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {Popover, PopoverContent, PopoverTrigger} from "@/components/ui/popover.tsx";


const useTimeAgo = () => {
  const {t} = useTranslation();
  const [now, setNow] = React.useState(Date.now());

  React.useEffect(() => {
    const interval = setInterval(() => setNow(Date.now()), 10000); // update every 10 seconds
    return () => clearInterval(interval);
  }, []);

  return (timestamp: number) => {
    const seconds = Math.floor(now / 1000 - timestamp);
    if (seconds < 60) return t('secondsAgo', {count: seconds});
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return t('minutesAgo', {count: minutes});
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('hoursAgo', {count: hours});
    const days = Math.floor(hours / 24);
    return t('daysAgo', {count: days});
  };
}

const Skeleton: React.FC<{ className?: string }> = ({ className = "" }) => (
  <div className={`animate-pulse bg-slate-200 dark:bg-slate-700 rounded-md ${className}`} />
);

const AssetsDisplay: React.FC<{ profileId: string }> = ({ profileId }) => {
  const { t } = useTranslation();
  const timeAgo = useTimeAgo();
  const config = useWebSocketStore((e) => e.configStore[profileId]);
  const [open, setOpen] = useState(Array.from({ length: 8 }).map(() => false));

  const noData = !config || Object.keys(config).length === 0;

  if (noData) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-4 gap-2 p-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="flex items-center bg-white dark:bg-slate-800/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700"
          >
            <Skeleton className="w-10 h-10 rounded-full mr-4" />
            <div className="flex-1 space-y-2">
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const assetItems = [
    {
      name: t("property.ap"),
      value: `${config.ap.count}/${config.ap.max}`,
      time: config.ap.time,
      icon: "/assets/icons/property/currency_icon_ap.webp",
    },
    {
      name: t("property.credits"),
      value: config.creditpoints.count.toLocaleString(),
      time: config.creditpoints.time,
      icon: "/assets/icons/property/currency_icon_gold.webp",
    },
    {
      name: t("property.pyroxene"),
      value: config.pyroxene.count.toLocaleString(),
      time: config.pyroxene.time,
      icon: "/assets/icons/property/currency_icon_gem.webp",
    },
    {
      name: t("property.coin.arena"),
      value: config.tactical_challenge_coin.count.toLocaleString(),
      time: config.tactical_challenge_coin.time,
      icon: "/assets/icons/property/item_icon_chasecoin.webp",
    },
    {
      name: t("property.coin.commission"),
      value: config.bounty_coin.count,
      time: config.bounty_coin.time,
      icon: "/assets/icons/property/item_icon_arenacoin.webp",
    },
    {
      name: t("property.keystone"),
      value: config.create_item_holding_quantity.Keystone?.toLocaleString() || "-1",
      time: config.pyroxene.time,
      icon: "/assets/icons/property/item_icon_craftitem_1.webp",
    },
    {
      name: t("property.keystone.piece"),
      value: config.create_item_holding_quantity["Keystone-Piece"]?.toLocaleString() || "-1",
      time: config.pyroxene.time,
      icon: "/assets/icons/property/item_icon_craftitem_0.webp",
    },
    {
      name: t("property.pass"),
      value: `${config._pass.level}/${config._pass.max_level}`,
      time: config._pass.time,
      icon: "/assets/icons/property/item_icon_pass.webp",
    },
  ];

  return (
    <div className="max-[320px]:hidden grid sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-4 gap-2">
      {assetItems.map((item, idx) => (
        <Popover
          key={item.name}
          open={open[idx]}
          onOpenChange={() =>
            setOpen((prev) => {
              const copy = [...prev];
              copy[idx] = false;
              return copy;
            })
          }
        >
          <PopoverTrigger asChild>
            <div
              onMouseEnter={() =>
                setOpen((prev) => {
                  const copy = [...prev];
                  copy[idx] = false;
                  return copy;
                })
              }
              onMouseLeave={() =>
                setOpen((prev) => {
                  const copy = [...prev];
                  copy[idx] = false;
                  return copy;
                })
              }
              className="bg-white dark:bg-slate-800/50 p-3 rounded-lg border border-slate-200 dark:border-slate-700 flex items-start transition-transform hover:scale-[1.02]"
            >
              <div className="flex flex-col items-center justify-center mr-4 min-w-10 ml-1">
                <img src={item.icon} className="w-8 h-6" alt={item.name} />
                <div className="text-sm text-slate-500 dark:text-slate-400">{item.name}</div>
              </div>
              <div>
                <div className="text-l font-bold text-slate-800 dark:text-slate-100">{item.value}</div>
                <div className="text-xs text-slate-400 dark:text-slate-500 mt-1">{timeAgo(item.time)}</div>
              </div>
            </div>
          </PopoverTrigger>

          <PopoverContent className="w-56 p-2 mr-6 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 max-h-100 overflow-y-auto" />
        </Popover>
      ))}
    </div>
  );
};


export default AssetsDisplay;
