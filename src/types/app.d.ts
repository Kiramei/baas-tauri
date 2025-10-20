import {DynamicConfig} from "@/types/dynamic";
import {Dispatch, SetStateAction} from "react";
import {PageKey} from "@/App.tsx";

export interface ConfigProfile {
  id: string;
  name: string;
  settings: DynamicConfig;
}

export interface UISettings {
  lang: string;
  theme: string;
  zoomScale: number;
  scrollToEnd: boolean;
  assetsDisplay: boolean;
}

export type Theme = 'light' | 'dark' | 'system';

export type ProfileProps = {
  profileId?: string;
  setActivePage?: Dispatch<SetStateAction<PageKey>>;
};

export interface ProfileDTO {
  id: string;
  name: string;
  server: string;
  settings: DynamicConfig;
}