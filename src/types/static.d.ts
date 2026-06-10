export interface StaticConfig {
  steam_app_process_name: string;
  main_story_final_episode_num: number;
  main_story_available_episodes: CurrentGameActivity;
  max_region: CurrentGameActivity;
  explore_normal_task_region_range: number[];
  explore_hard_task_region_range: number[];
  screenshot_methods: string[];
  control_methods: string[];
  shop_type_list_names: LessonRegionName;
  common_shop_price_list: CommonShopPriceList;
  tactical_challenge_shop_price_list: CurrentGameActivity;
  create_default_priority: CreateDefaultPriority;
  create_each_phase_weight: number[];
  create_filter_type_list: CreateFilterTypeList;
  create_item_order: CreateItemOrder;
  create_phase2_recommended_priority: { [key: string]: number[] };
  create_material_information: { [key: string]: CreateMaterialInformation };
  lesson_region_name: LessonRegionName;
  current_game_activity: CurrentGameActivity;
  dailyGameActivity: CurrentGameActivity;
  package_name: Name;
  activity_name: Name;
  total_assault_difficulties: CurrentGameActivity;
  hard_task_student_material: Array<string[]>;
  student_names: StudentName[];
}

export interface Name {
  官服: string;
  B服: string;
  国际服: string;
  国际服青少年: string;
  韩国ONE: string;
  日服: string;
}

export interface CommonShopPriceList {
  CN: Array<CommonShopPriceListCN[]>;
  Global: Array<CommonShopPriceListCN[]>;
  JP: Array<CommonShopPriceListCN[]>;
}

export type CommonShopPriceListCN = number | string;

export interface CreateDefaultPriority {
  CN: GlobalKoKrClass;
  Global: GlobalKoKrClass;
  "Global_zh-tw": GlobalKoKrClass;
  "Global_ko-kr": GlobalKoKrClass;
  JP: GlobalKoKrClass;
}

export interface GlobalKoKrClass {
  phase1: string[];
  phase2: string[];
  phase3: string[];
}

export interface CreateFilterTypeList {
  CN: string[];
  Global: string[];
  JP: string[];
}

export interface CreateItemOrder {
  CN: CreateItemOrderCN;
  Global: CreateItemOrderCN;
  JP: CreateItemOrderCN;
}

export interface CreateItemOrderCN {
  basic: Basic;
}

export interface Basic {
  Special: string[];
  Equipment: any[];
  Furniture: any[];
  Decoration: any[];
  Interior: any[];
  Eleph: any[];
  Coin: any[];
  Material: string[];
  Gift: any[];
  Disk?: string[];
  Note?: string[];
}

export interface CreateMaterialInformation {
  weight: number;
  availability: Availability;
  material_type: MaterialType;
}

export interface Availability {
  phase1: boolean;
  phase2: boolean;
  phase3: boolean;
}

// noinspection JSUnusedGlobalSymbols
export enum MaterialType {
  Material = "Material",
  Special = "Special",
}

export interface CurrentGameActivity {
  CN: CN;
  Global: Global;
  JP: Jp;
}

export type CN = PurpleCN[] | number | null;

export type PurpleCN = CommonShopPriceListCN[] | number | string;

export type Global = PurpleCN[] | number | null | string;

export type Jp = PurpleCN[] | number | null | string;

export interface LessonRegionName {
  CN: string[];
  "Global_en-us": string[];
  "Global_zh-tw": string[];
  "Global_ko-kr": string[];
  JP: string[];
}

export interface StudentName {
  CN_name: string;
  CN_implementation: boolean;
  Global_name: string;
  Global_implementation: boolean;
  JP_name: string;
  JP_implementation: boolean;
}
