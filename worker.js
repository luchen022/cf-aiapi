import { fetch as routerFetch } from "./routes/router.js";

export default {
  async fetch(request, env) {
    return routerFetch(request, env);
  },

  // Cron Trigger 处理函数 - 用于预热 Worker 防止冷启动
  async scheduled(event, env, ctx) {
    // 发送一个简单的健康检查请求到自己，保持 Worker 预热状态
    // 这不会消耗任何 AI 额度，只是唤醒 Worker
    const url = 'https://ai.jaden.de5.net/health';
    try {
      const response = await fetch(url, { method: 'GET' });
      console.log(`Warm-up ping completed at ${new Date().toISOString()}, status: ${response.status}`);
    } catch (error) {
      console.error(`Warm-up ping failed: ${error.message}`);
    }
  }
};