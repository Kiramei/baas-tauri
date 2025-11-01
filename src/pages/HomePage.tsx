import React, {useMemo} from 'react';
import {useTranslation} from 'react-i18next';
import {useApp} from '../contexts/AppContext';
import CButton from '../components/ui/CButton.tsx';
import Logger from '../components/ui/Logger';
import AssetsDisplay from '../components/AssetsDisplay';
import {Card, CardContent, CardHeader, CardTitle} from '../components/ui/Card';
import {FileUp, ListEnd, Logs, Play, Square} from 'lucide-react';
import SwitchButton from "@/components/ui/SwitchButton.tsx";
import {ProfileProps} from "@/types/app";
import {TaskStatus} from "@/components/HomeTaskStatus.tsx";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {formatIsoToReadable, getTimestamp, getTimestampMs} from "@/lib/utils.ts";

/**
 * Landing experience for a profile that provides orchestration controls, status, and live logs.
 */
const HomePage: React.FC<ProfileProps> = ({profileId}) => {
  const {t} = useTranslation();
  const {uiSettings, setUiSettings} = useApp();
  const {profiles, activeProfile} = useApp();
  const pid = profileId ?? activeProfile?.id;
  const profile = useMemo(
    () => profiles.find(p => p.id === pid) ?? activeProfile ?? null,
    [profiles, pid, activeProfile]
  );

  const statusStore = useWebSocketStore((state) => state.statusStore);
  const trigger = useWebSocketStore((state) => state.trigger);
  const logStore = useWebSocketStore((state) => state.logStore);

  const scriptRunning = statusStore[profileId!]?.running || false;

  /**
   * Issues the scheduler start command for the active profile.
   * Guarded against duplicate submissions when a run is already active.
   */
  const startScript = () => {
    if (!profile || scriptRunning) return;
    trigger({
      timestamp: getTimestampMs(),
      command: "start_scheduler",
      config_id: profileId,
      payload: {}
    }, (response) => {
      console.debug("start_scheduler acknowledged", response);
    });
  };

  /**
   * Sends a stop signal to the scheduler for the active profile.
   */
  const stopScript = () => {
    if (!profile || !scriptRunning) return;
    trigger({
      timestamp: getTimestamp(),
      command: "stop_scheduler",
      config_id: profileId,
      payload: {}
    }, (response) => {
      console.debug("stop_scheduler acknowledged", response);
    });
  };

  /**
   * Serializes the on-screen log buffer and triggers a local download for auditing or support.
   */
  const exportLog = () => {
    const content = logStore[`config:${profileId}`].map(
      (entry) => `[${formatIsoToReadable(entry.time)}] ${entry.level}: ${entry.message}`
    ).join('\n');

    const blob = new Blob([content], {type: 'text/plain;charset=utf-8'});
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `logs-${new Date().toISOString()}.txt`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="h-full flex flex-col min-h-0 gap-2">
      {/* Header: high-level actions and script controls. */}
      <div className="flex justify-between items-center shrink-0">
        <div className="flex">
          <h2 className="text-2xl font-bold text-slate-800 dark:text-slate-100">{t('home')}</h2>
          <h2 className="text-2xl ml-3 text-slate-500 dark:text-slate-400">#{profile?.name}</h2>
        </div>
        <div className="flex items-center gap-2">
          <CButton
            onClick={scriptRunning ? stopScript : startScript}
            variant={scriptRunning ? 'danger' : 'primary'}
            className="w-25 pl-3 flex items-center justify-center"
          >
            {scriptRunning ? <Square className="w-4 h-4 mr-2"/> : <Play className="w-4 h-4 mr-2"/>}
            {scriptRunning ? t('stop') : t('start')}
          </CButton>
        </div>
      </div>

      {/* Live status for the active task pipeline. */}
      <TaskStatus profileId={profileId!}/>

      {/* Optional asset snapshot to provide immediate operational context. */}
      {uiSettings?.assetsDisplay && (
        <div className="shrink-0">
          <AssetsDisplay profileId={profileId!}/>
        </div>
      )}

      {/* Streaming log viewer with scroll management and export tooling. */}
      <Card className="flex-1 min-h-100 flex flex-col">
        <CardHeader className="flex justify-between items-center">
          <CardTitle>
            <div className="flex items-center gap-2">
              <Logs/> {t('logs')}
            </div>
          </CardTitle>
          <div className="sm:flex hidden items-center justify-center">
            <SwitchButton
              checked={uiSettings?.scrollToEnd!}
              onChange={value => {
                setUiSettings(state => ({...state, scrollToEnd: value}));
              }}
              label={t('log.scroll')}
              className="!px-4"
            />
            <CButton onClick={exportLog} className="ml-2">
              <div className="flex">
                <FileUp size={20} className="mr-2"/>
                {t('log.export')}
              </div>
            </CButton>
          </div>

          <div className="sm:hidden flex items-center justify-center">
            <SwitchButton
              checked={uiSettings?.scrollToEnd}
              onChange={value => {
                setUiSettings(state => ({...state, scrollToEnd: value}));
              }}
              label=""
              className="!px-4 ml-2 w-8 h-8"
            >
              <ListEnd size={20} className="rounded w-4 h-4 translate-x-[-8px]"/>
            </SwitchButton>
            <CButton onClick={exportLog} className="ml-2 w-8 h-8">
              <FileUp size={20} className="rounded w-4 h-4 translate-x-[-8px]"/>
            </CButton>
          </div>
        </CardHeader>

        <CardContent className="flex-1 min-h-0 p-0 flex overflow-x-hidden">
          <Logger logs={logStore[`config:${profileId}`]} scrollToEnd={uiSettings?.scrollToEnd}/>
        </CardContent>
      </Card>
    </div>
  );
};

export default HomePage;
