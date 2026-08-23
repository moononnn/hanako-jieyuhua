// 解语花 · Interactive Card 发送入口
// 卡片只传 rid + index，正文由服务端从 pending 记录取回，不能伪造任意文本。

import { claimAndSend } from "../lib/send.js";

export const name = "apply_suggestion";
export const description = "发送解语花推荐列表中的指定一条回复。只接受卡片生成的 rid 和序号，不接受自定义正文。";
export const sessionPermission = {
  kind: "external_side_effect",
  description: "会把用户点选的推荐回复作为一条真实用户消息发送到目标会话。",
};
export const parameters = {
  type: "object",
  properties: {
    rid: {
      type: "string",
      description: "推荐列表编号，由解语花卡片固定传入",
    },
    index: {
      type: "integer",
      minimum: 0,
      maximum: 3,
      description: "推荐列表中的序号，从 0 开始",
    },
  },
  required: ["rid", "index"],
};

export async function execute(input, ctx) {
  const result = await claimAndSend(ctx.dataDir, {
    rid: typeof input?.rid === "string" ? input.rid : "",
    index: Number.isInteger(input?.index) ? input.index : -1,
  }, ctx.bus);
  if (!result.ok) return { ok: false, content: [{ type: "text", text: result.error || "发送失败" }] };
  return { ok: true, content: [{ type: "text", text: "已发送" }] };
}
