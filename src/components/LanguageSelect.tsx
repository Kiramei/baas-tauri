import React from "react";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { useAppTranslation } from "@/shared/useAppTranslation";

/** Renders the language select component. */
const LanguageSelect: React.FC<{
  handleLanguageChange: (value: string) => void;
  className?: string;
  hideLabel?: boolean;
}> = ({ handleLanguageChange, className, hideLabel = false }) => {
  const { t, i18n } = useAppTranslation();
  return (
    <FormSelect
      value={i18n.language}
      label={hideLabel ? undefined : t("language")}
      ariaLabel={t("language")}
      onChange={handleLanguageChange}
      options={[
        { value: "en", label: t("language.english") },
        { value: "zh", label: t("language.chinese") },
        { value: "ja", label: t("language.japanese") },
        { value: "ko", label: t("language.korean") },
        { value: "de", label: t("language.deutsch") },
        { value: "ru", label: t("language.russian") },
        { value: "fr", label: t("language.french") },
      ]}
      className={className}
    />
  );
};

export default LanguageSelect;
