import React from "react";
import { FormSelect } from "@/components/ui/FormSelect.tsx";
import { useTranslation } from "react-i18next";

const LanguageSelect: React.FC<{
  handleLanguageChange: (value: string) => void;
  className?: string;
}> = ({ handleLanguageChange, className }) => {
  const { t, i18n } = useTranslation();
  return (
    <FormSelect
      value={i18n.language}
      label={t("language")}
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
