import assert from "node:assert/strict";
import { buildLegacyCapabilitySnapshot } from "./iam-capabilities.js";
import type { SessionUser } from "../types.js";

const actor = (role: SessionUser["role"]): SessionUser => ({
  id: `user_${role}`,
  name: role,
  email: `${role}@example.test`,
  role,
  teamId: role === "super_admin" ? "all" : "tenant_a",
  avatar: "T",
  authVersion: 1
});

const sales = buildLegacyCapabilitySnapshot(actor("sales"));
assert.ok(sales.permissions["customer.read"]?.includes("self"));
assert.ok(sales.permissions["customer.export"]?.includes("self"));
assert.ok(sales.permissions["customer.pool.claim"]?.includes("public_pool"));

const manager = buildLegacyCapabilitySnapshot(actor("manager"));
assert.ok(manager.permissions["customer.export"]?.includes("org_subtree"));
assert.equal(manager.permissions["role.manage"], undefined);

const admin = buildLegacyCapabilitySnapshot(actor("admin"));
assert.ok(admin.permissions["role.manage"]?.includes("tenant"));

const superAdmin = buildLegacyCapabilitySnapshot(actor("super_admin"));
assert.equal(superAdmin.source, "legacy_compatibility");
assert.equal(superAdmin.roleNames[0], "超级管理员");
assert.ok(superAdmin.permissions["member.manage"]?.includes("tenant"));
assert.ok(superAdmin.permissions["customer.read"]?.includes("tenant"));
assert.ok(superAdmin.permissions["audit.read"]?.includes("tenant"));
assert.equal(superAdmin.permissions["platform.audit.read"], undefined);

console.log(JSON.stringify({ ok: true, capabilitySnapshot: true, roleNamesIgnoredByUi: true }, null, 2));
