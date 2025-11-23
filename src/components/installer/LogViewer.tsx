import React, { useEffect, useRef } from 'react';
// import { ScrollArea } from "@/components/ui/scroll-area"; // Assuming you have shadcn/ui or similar
import { Button } from "@/components/ui/button";
import { Copy, Terminal } from 'lucide-react';
import { toast } from 'sonner';
import {useGlobalLogStore} from "@/store/globalLogStore.ts";


export const LogViewer: React.FC = () => {
    const scrollRef = useRef<HTMLDivElement>(null);
    const globalLogData = useGlobalLogStore(e=>e.globalLogData);

    useEffect(() => {
        if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }
    }, [globalLogData]);

    const copyLogs = () => {
        const text = globalLogData.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
        navigator.clipboard.writeText(text).then(undefined);
        toast.success("Logs copied to clipboard");
    };

    const getColor = (level: string) => {
        switch (level) {
            case 'success': return 'text-green-400';
            case 'warning': return 'text-yellow-400';
            case 'error': return 'text-red-400';
            default: return 'text-blue-400';
        }
    };

    return (
      <div className="rounded-lg border border-border bg-transparent text-card-foreground shadow-sm overflow-hidden flex flex-col h-[400px]">
        <div className="flex items-center justify-between px-3 py-0 border-b border-border bg-muted/50">
          <div className="flex items-center gap-2">
            <button className="w-3 h-3 rounded-full bg-red-500 hover:bg-red-600 focus:outline-none transition duration-150 ease-in-out"/>
            <button className="w-3 h-3 rounded-full bg-yellow-500 hover:bg-yellow-600 focus:outline-none transition duration-150 ease-in-out"/>
            <button className="w-3 h-3 rounded-full bg-green-500 hover:bg-green-600 focus:outline-none transition duration-150 ease-in-out"/>
          </div>

          <div className="flex items-center gap-2 text-sm font-medium">
            <Terminal className="w-4 h-4" />
            <span>Installation Logs</span>
          </div>

          <Button variant="ghost" size="icon" onClick={copyLogs}>
            <Copy className="w-4 h-4" />
          </Button>
        </div>

        <div className="flex-1 overflow-auto p-4 font-mono text-xs bg-white/50 dark:bg-black/50 text-gray-300" ref={scrollRef}>
          {globalLogData.length === 0 && <div className="text-gray-500 italic">Waiting for logs...</div>}
          {globalLogData.map((log, i) => (
            <div key={i} className="mb-1 break-words allow-select-text cursor-text">
              <span className="text-gray-500 mr-2">[{log.time}]</span>
              <span className={getColor(log.level)}>{log.message}</span>
            </div>
          ))}
        </div>
      </div>

    );
};
