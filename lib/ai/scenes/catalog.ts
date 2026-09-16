export type AllowedScene = {
  id: "home";
  name: string;
  aliases: string[];
  description: string;
  source: "mi_home_existing_scene";
  executor: "mi_cloud";
  riskLevel: "low";
  enabledForAi: true;
};

export const allowedScenes: AllowedScene[] = [
  {
    id: "home",
    name: "回家模式",
    aliases: ["我回家了", "我到家了", "我回来了", "刚进门", "开启回家模式", "打开回家模式"],
    description: "用户已经回到家后激活",
    source: "mi_home_existing_scene",
    executor: "mi_cloud",
    riskLevel: "low",
    enabledForAi: true,
  },
];
