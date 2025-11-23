import React from 'react';
import {motion} from 'framer-motion';
import {useGlobalLogStore} from "@/store/globalLogStore.ts";

export const ProgressBar: React.FC = () => {
  const globalProgress = useGlobalLogStore(e => e.globalProgress);

  return (
    <div className="w-full space-y-2">
      <div className="flex justify-between text-sm">
        <span className="font-medium">{globalProgress.message}</span>
        <span className="text-muted-foreground">{globalProgress.progress}%</span>
      </div>
      <div className="h-2 bg-secondary rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-primary-600"
          initial={{width: 0}}
          animate={{width: `${globalProgress.progress}%`}}
          transition={{type: "spring", stiffness: 50, damping: 15}}
        />
      </div>
    </div>
  );
};
