import React, {useState} from "react";
import {useTranslation} from "react-i18next";
import CButton from "@/components/ui/CButton.tsx";
import {Card} from "@/components/ui/Card";
import {Modal} from "@/components/ui/Modal";
import {Loader2, SearchCode} from "lucide-react";
import {useWebSocketStore} from "@/store/websocketStore.ts";
import {getTimestampMs} from "@/lib/utils.ts";

type ADBSeekProps = {
  onSelect?: (addr: string) => void;
};

const ADBSeekModal: React.FC<ADBSeekProps> = ({onSelect}) => {
  const {t} = useTranslation();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const trigger = useWebSocketStore(state => state.trigger)

  const handleDetect = async () => {
    setLoading(true);

    trigger({
      timestamp: getTimestampMs(),
      command: "detect_adb",
      payload: {}
    }, (e) => {
      console.log("detect_adb", e.data.addresses);
      const addrList = e.data.addresses;
      if (!addrList || addrList.length === 0) {
        setResults([]);
      } else {
        setResults(addrList);
      }
      setLoading(false);
    });
  };

  return (
    <>
      {/* Trigger button */}
      <CButton variant="primary" onClick={() => setOpen(true)} style={
        {
          borderRadius: "50%",
          padding: "8px",
          width: "36px",
          height: "36px"
        }
      }>
        <SearchCode size={20}/>
      </CButton>

      {/* Modal */}
      <Modal
        isOpen={open}
        onClose={() => setOpen(false)}
        title={t("adb.title")}
        width={40}
      >
        <div className="space-y-2">
          <CButton
            onClick={handleDetect}
            disabled={loading}
            className="w-full"
          >
            {loading ? (
              <div className="flex justify-center items-center">
                <Loader2 className="animate-spin mr-2 h-4 w-4"/>
                {t("adb.detecting")}
              </div>
            ) : (
              <div className="flex justify-center items-center">
                <SearchCode className="mr-2 h-4 w-4"/>
                {t("adb.detectBtn")}
              </div>
            )}
          </CButton>

          <div className="space-y-2 max-h-60 overflow-y-auto">
            {results.map((addr) => (
              <Card
                key={addr}
                className="p-2 cursor-pointer hover:bg-slate-100 dark:hover:bg-slate-700"
                onClick={() => {
                  onSelect?.(addr);
                  setOpen(false); // Close the modal after a selection is made.
                }}
              >
                {addr}
              </Card>
            ))}
            {results.length === 0 && !loading && (
              <p className="text-sm text-slate-500">
                {t("adb.noData") || "No results found"}
              </p>
            )}
          </div>
        </div>
      </Modal>
    </>
  );
};

export default ADBSeekModal;
