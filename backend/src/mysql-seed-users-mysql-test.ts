import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mysql from "mysql2/promise";
import type { RowDataPacket } from "mysql2/promise";
import { createMysqlStore } from "./mysql-store.js";

function connectionOptions(databaseUrl: URL) {
  return {
    host: databaseUrl.hostname,
    port: Number(databaseUrl.port || 3306),
    user: decodeURIComponent(databaseUrl.username),
    password: decodeURIComponent(databaseUrl.password)
  };
}

async function main() {
  const configuredUrl = process.env.MYSQL_TEST_ADMIN_URL;
  if (!configuredUrl) {
    throw new Error("Seed users MySQL test requires MYSQL_TEST_ADMIN_URL");
  }

  const adminUrl = new URL(configuredUrl);
  const databaseName = `goodjob_seed_users_test_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const admin = await mysql.createConnection(connectionOptions(adminUrl));
  let databaseCreated = false;
  let exitCode = 1;

  try {
    await admin.query(
      `CREATE DATABASE \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
    databaseCreated = true;
    const testUrl = new URL(configuredUrl);
    testUrl.pathname = `/${databaseName}`;
    process.env.DATABASE_URL = testUrl.toString();
    delete process.env.MYSQL_URL;

    // NODE_ENV=test ⇒ seedDevelopmentData=true：空库会种子化演示用户（含 super_admin super@goodjob.com）
    const store = await createMysqlStore();

    const superAdmins = store.users.filter((user) => user.role === "super_admin");
    assert.ok(superAdmins.length >= 1, "应至少存在一个 super_admin 种子用户");
    assert.ok(
      store.users.some((user) => user.email === "super@goodjob.com"),
      "演示 super_admin（super@goodjob.com）应被种子化"
    );

    // 核心不变量：每个 super_admin 都必须有 active 的 platform_operators 行，
    // 否则登录会报「平台运维账号已停用」。种子用户在 IAM 基础表初始化之后入库，
    // 依赖 createMysqlStore 在种子化后补跑 ensureIamFoundationSchema。
    const [operatorRows] = await admin.query<Array<RowDataPacket & { email: string }>>(
      `SELECT po.user_id AS user_id, po.status AS status, u.email AS email
       FROM \`${databaseName}\`.platform_operators po
       JOIN \`${databaseName}\`.users u ON u.id = po.user_id`
    );
    const activeOperatorUserIds = new Set(
      operatorRows.filter((row) => row.status === "active").map((row) => row.user_id)
    );
    for (const superAdmin of superAdmins) {
      assert.ok(
        activeOperatorUserIds.has(superAdmin.id),
        `super_admin ${superAdmin.email} 缺少 active 的 platform_operators 行`
      );
    }

    console.log("Seed users MySQL platform_operators regression test passed");
    exitCode = 0;
  } catch (error) {
    console.error(error);
  } finally {
    if (databaseCreated) {
      await admin.query(`DROP DATABASE IF EXISTS \`${databaseName}\``);
    }
    await admin.end();
    process.exit(exitCode);
  }
}

await main();
