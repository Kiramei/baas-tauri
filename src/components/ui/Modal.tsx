import React, {useEffect} from 'react';
import {X} from 'lucide-react';
import {motion} from "framer-motion";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: React.ReactNode;
  width?: number;
}

export const Modal: React.FC<ModalProps> = ({isOpen, onClose, title, children, width = 40}) => {
  useEffect(() => {
    const handleEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose();
      }
    };
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('keydown', handleEsc);
    };
  }, [onClose]);

  if (!isOpen) return null;

  const overlayCls = "fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50";

  return (
    <div className={overlayCls} onMouseDown={(e) => {
      if (e.target === e.currentTarget) onClose();
    }}>
      <motion.div
        initial={{opacity: 0, y: 8}}
        animate={{opacity: 1, y: 0}}
        exit={{opacity: 0, y: 8}}
        transition={{duration: 0.16}}
        onMouseDown={(e) => e.stopPropagation()}
        className='rounded-xl bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-700 shadow-xl p-5 px-3'
        style={{width: `${width}%`, minWidth: '400px'}}
      >
        <div className='overflow-auto px-2' style={{maxHeight: 'calc(100vh - 80px)'}}>
          <div className="flex items-center justify-between p-0 border-b border-slate-200 dark:border-slate-700">
            <h2 className="text-xl font-semibold text-slate-800 dark:text-slate-100">{title}</h2>
            <button onClick={onClose} className="p-1 rounded-full hover:bg-slate-100 dark:hover:bg-slate-700">
              <X className="w-5 h-5 text-slate-500"/>
            </button>
          </div>
          <div className="py-2 overflow-y-auto px-1">
            {children}
          </div>
        </div>
      </motion.div>
    </div>
  );
};
