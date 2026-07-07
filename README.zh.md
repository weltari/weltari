<div align="center">

<h1>Weltari</h1>

<p><em>一个自托管的 AI 世界引擎 —— 你不是在读一个故事,而是身处一个地方。</em></p>

<p>
  <img alt="许可证" src="https://img.shields.io/badge/license-AGPL--3.0--only-blue">
  <img alt="Node" src="https://img.shields.io/badge/node-24_LTS-339933?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white">
  <img alt="状态" src="https://img.shields.io/badge/status-active_development-orange">
</p>

<p>
  <a href="README.md"><img alt="English" src="https://img.shields.io/badge/lang-English-lightgrey?style=for-the-badge"></a>
  <a href="README.de.md"><img alt="Deutsch" src="https://img.shields.io/badge/lang-Deutsch-lightgrey?style=for-the-badge"></a>
  <img alt="中文" src="https://img.shields.io/badge/lang-%E4%B8%AD%E6%96%87-2b7489?style=for-the-badge">
</p>

</div>

---

> **Weltari 是一个自托管的 AI 世界引擎 —— 你不是在"读"一个故事,而是"身处"一个地方:** 你站在一张活生生的**世界地图(World Map)**上,走进某个地点就会开启一个**场景(Scene)**,它像视觉小说一样逐句流动,由 AI 担任旁白与角色;而你所做的一切都会被永久记住。所以地图**就是**这个世界,而场景就是"你正身处这个世界的某一处"。

## Weltari 是什么?

Weltari 是一个你在自己电脑上运行的单一程序,用来承载活生生的、由 AI 驱动的角色扮演世界。可以把它想成视觉小说或文字冒险背后的引擎 —— 只不过旁白、角色乃至世界本身都由语言模型驱动,没有任何预先写死的剧本。

它是**自托管、单进程**的:没有云服务、没有订阅、没有哪家公司拥有你的世界。你把它接到一个 AI 提供商,其余一切都留在你自己的硬件上。并且它从设计上就让一切有意义的事情都被**永久记录** —— 世界会记得。

## 核心理念

### 🗺️ 世界地图 —— _你所在的位置_

世界地图不是菜单,也不是选关界面,而是你在这个世界里位置的"真实坐标"。你确实*身处某地* —— 一个真实的地点,有邻近区域、有距离,也有在你视线之外正在发生的事。在地图上移动,就是在改变**你所在的位置**。

### 🎬 场景 —— _你正身处其中_

走进一个地点就会开启一个场景:流式旁白、逐句推进的节奏(点击或自动播放)、带立绘和姿态的角色、在你于子地点(sublocation)之间移动时滑动切换的背景。场景是你所站之处的"特写镜头" —— 是你亲身演出的**身处此地**。世界地图 → 场景,是整个应用的"语法":它是空间性的,而非菜单式的。

### 🧱 持久且抗崩溃

每一个有意义的事件 —— 一句对白、一个场景的结束、角色的一段私密"反思"、一张被绘制出来的图像 —— 都会写进一个**只追加(append-only)的日志**,永远无法修改或删除,只能追加。如果程序在半句话中间被强行杀掉再重启,它会*精确地*从中断处继续 —— 不丢失、不重复。这一点经过了在每个故障点各 100 次强制崩溃循环的压力测试:零丢失、零重复事件,零损坏图像。

### 🔌 无需重建即可扩展

往 `plugins/` 里丢一个文件夹 —— 一个新主题、一张地图、一个自定义界面 —— 然后重启即可。无需编译,无需开发者环境。每个插件都带有指纹(每次加载都做哈希校验),被篡改的插件会被自动拒绝,而应用照常启动。

## 项目进度

Weltari 正处于**积极开发**中,是自托管的、爱好者规模的项目。地基已经完成并经过验证;面向玩家的界面正在搭建。

| 里程碑 | 范围 | 状态 |
| --- | --- | --- |
| **M1 —— 能走通的骨架** | 端到端的 AI 回合、流式输出、可崩溃恢复且能续传的事件日志 | ✅ 已完成 |
| **M2 —— 持久性与丰富度** | 反思扇出、图像合成、世界时钟 / 时间跳跃、崩溃安全加固 | ✅ 已完成 |
| **M3 —— 玩家体验** | 真正的视觉小说场景页、场景引擎工具、插件加载器、默认地图 | 🚧 进行中 |

目前还没有"一条命令即可游玩"的构建 —— 这份 README 用来介绍项目,而不是提供安装包。

## 技术栈

- **TypeScript**(strict)、**Node 24 LTS**、纯 ESM、npm workspaces
- **前端:** React 19 + Vite
- **通信协议:** 在每一个信任边界上用 Zod 校验的 schema
- **存储:** 基于 SQLite 的只追加事件存储
- **LLM:** 构建在 AI SDK 之上、与提供商解耦的一层,固定提供商并显式做提示词缓存

## 许可证

核心采用 **AGPL-3.0-only**。通信协议(`packages/protocol`)与插件 SDK(`packages/plugin-sdk`)采用 **MIT**,因此插件与集成可以自由构建。

---

<div align="center"><sub>Weltari · 自托管 AI 世界引擎 · 积极开发中</sub></div>
