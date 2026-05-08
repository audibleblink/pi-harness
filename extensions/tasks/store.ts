/**
 * store.ts — File-backed task store with CRUD, dependency management, and file locking.
 *
 * Ported verbatim from extensions/orchestration/task-store.ts (on-disk format identical).
 *
 * Also owns the canonical agentTaskMap (P5 invariant: this file is the sole owner of
 * the agentId → taskId binding).
 */

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";

export type TaskStatus = "pending" | "in_progress" | "completed";

export interface Task {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
  activeForm?: string;
  owner?: string;
  metadata: Record<string, any>;
  blocks: string[];
  blockedBy: string[];
  createdAt: number;
  updatedAt: number;
}

export interface TaskStoreData {
  nextId: number;
  tasks: Task[];
}

/**
 * agentId → taskId binding, populated by TaskExecute, consumed by cascade (P6).
 *
 * INVARIANT: this map's literal identifier `agentTaskMap` lives ONLY in this file.
 * All consumers must go through the exported helpers below.
 */
const agentTaskMap = new Map<string, string>();

export function setTaskBinding(agentId: string, taskId: string): void {
  agentTaskMap.set(agentId, taskId);
}
export function getTaskByAgent(agentId: string): string | undefined {
  return agentTaskMap.get(agentId);
}
export function deleteTaskBinding(agentId: string): void {
  agentTaskMap.delete(agentId);
}
export function findTaskIdByAgentPrefix(agentIdPrefix: string): string | undefined {
  for (const [agentId, taskId] of agentTaskMap) {
    if (agentId === agentIdPrefix || agentId.startsWith(agentIdPrefix)) return taskId;
  }
  return undefined;
}

function resolveTasksDir(): string {
  const piDir = process.env.PI_CODING_AGENT_DIR;
  if (piDir) return join(piDir, "tasks");
  const legacy = join(homedir(), ".pi", "tasks");
  const xdg = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  const xdgPath = join(xdg, "pi", "agent", "tasks");
  if (existsSync(legacy) && !existsSync(xdgPath)) return legacy;
  return xdgPath;
}

const TASKS_DIR = resolveTasksDir();
const LOCK_RETRY_MS = 50;
const LOCK_MAX_RETRIES = 100;

function acquireLock(lockPath: string): void {
  for (let i = 0; i < LOCK_MAX_RETRIES; i++) {
    try {
      writeFileSync(lockPath, `${process.pid}`, { flag: "wx" });
      return;
    } catch (e: any) {
      if (e.code === "EEXIST") {
        try {
          const pid = parseInt(readFileSync(lockPath, "utf-8"), 10);
          if (pid && !isProcessRunning(pid)) {
            unlinkSync(lockPath);
            continue;
          }
        } catch { /* ignore read errors */ }
        const start = Date.now();
        while (Date.now() - start < LOCK_RETRY_MS) { /* busy wait */ }
        continue;
      }
      throw e;
    }
  }
  throw new Error(`Failed to acquire lock: ${lockPath}`);
}

function releaseLock(lockPath: string): void {
  try { unlinkSync(lockPath); } catch { /* ignore */ }
}

function isProcessRunning(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export class TaskStore {
  private filePath: string | undefined;
  private lockPath: string | undefined;

  private nextId = 1;
  private tasks = new Map<string, Task>();

  constructor(listIdOrPath?: string) {
    if (!listIdOrPath) return;
    const isAbsPath = isAbsolute(listIdOrPath);
    const filePath = isAbsPath ? listIdOrPath : join(TASKS_DIR, `${listIdOrPath}.json`);
    mkdirSync(dirname(filePath), { recursive: true });
    this.filePath = filePath;
    this.lockPath = filePath + ".lock";
    this.load();
  }

  private load(): void {
    if (!this.filePath) return;
    if (!existsSync(this.filePath)) return;
    try {
      const data: TaskStoreData = JSON.parse(readFileSync(this.filePath, "utf-8"));
      this.nextId = data.nextId;
      this.tasks.clear();
      for (const t of data.tasks) this.tasks.set(t.id, t);
    } catch { /* corrupt file — start fresh */ }
  }

  private save(): void {
    if (!this.filePath) return;
    const data: TaskStoreData = {
      nextId: this.nextId,
      tasks: Array.from(this.tasks.values()),
    };
    const tmpPath = this.filePath + ".tmp";
    writeFileSync(tmpPath, JSON.stringify(data, null, 2));
    renameSync(tmpPath, this.filePath);
  }

  private withLock<T>(fn: () => T): T {
    if (!this.lockPath) return fn();
    acquireLock(this.lockPath);
    try {
      this.load();
      const result = fn();
      this.save();
      return result;
    } finally {
      releaseLock(this.lockPath);
    }
  }

  create(subject: string, description: string, activeForm?: string, metadata?: Record<string, any>): Task {
    return this.withLock(() => {
      const now = Date.now();
      const task: Task = {
        id: String(this.nextId++),
        subject,
        description,
        status: "pending",
        activeForm,
        owner: undefined,
        metadata: metadata ?? {},
        blocks: [],
        blockedBy: [],
        createdAt: now,
        updatedAt: now,
      };
      this.tasks.set(task.id, task);
      return task;
    });
  }

  get(id: string): Task | undefined { return this.tasks.get(id); }

  list(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => Number(a.id) - Number(b.id));
  }

  update(id: string, fields: {
    status?: TaskStatus | "deleted";
    subject?: string;
    description?: string;
    activeForm?: string;
    owner?: string;
    metadata?: Record<string, any>;
    addBlocks?: string[];
    addBlockedBy?: string[];
  }): { task: Task | undefined; changedFields: string[]; warnings: string[] } {
    return this.withLock(() => {
      const task = this.tasks.get(id);
      if (!task) return { task: undefined, changedFields: [], warnings: [] };

      const changedFields: string[] = [];
      const warnings: string[] = [];

      if (fields.status === "deleted") {
        this.tasks.delete(id);
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => bid !== id);
          t.blockedBy = t.blockedBy.filter(bid => bid !== id);
        }
        return { task: undefined, changedFields: ["deleted"], warnings: [] };
      }

      if (fields.status !== undefined) { task.status = fields.status; changedFields.push("status"); }
      if (fields.subject !== undefined) { task.subject = fields.subject; changedFields.push("subject"); }
      if (fields.description !== undefined) { task.description = fields.description; changedFields.push("description"); }
      if (fields.activeForm !== undefined) { task.activeForm = fields.activeForm; changedFields.push("activeForm"); }
      if (fields.owner !== undefined) { task.owner = fields.owner; changedFields.push("owner"); }

      if (fields.metadata !== undefined) {
        for (const [key, value] of Object.entries(fields.metadata)) {
          if (value === null) delete task.metadata[key];
          else task.metadata[key] = value;
        }
        changedFields.push("metadata");
      }

      const addEdges = (
        field: "blocks" | "blockedBy",
        reverse: "blockedBy" | "blocks",
        cycleCheckList: string[],
        targetIds: string[],
      ) => {
        for (const targetId of targetIds) {
          if (!task[field].includes(targetId)) task[field].push(targetId);
          const target = this.tasks.get(targetId);
          if (target && !target[reverse].includes(id)) {
            target[reverse].push(id);
            target.updatedAt = Date.now();
          }
          if (targetId === id) warnings.push(`#${id} blocks itself`);
          else if (!target) warnings.push(`#${targetId} does not exist`);
          else if (cycleCheckList.includes(targetId)) warnings.push(`cycle: #${id} and #${targetId} block each other`);
        }
        changedFields.push(field);
      };

      if (fields.addBlocks?.length) addEdges("blocks", "blockedBy", task.blockedBy, fields.addBlocks);
      if (fields.addBlockedBy?.length) addEdges("blockedBy", "blocks", task.blocks, fields.addBlockedBy);

      task.updatedAt = Date.now();
      return { task, changedFields, warnings };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.tasks.has(id)) return false;
      this.tasks.delete(id);
      for (const t of this.tasks.values()) {
        t.blocks = t.blocks.filter(bid => bid !== id);
        t.blockedBy = t.blockedBy.filter(bid => bid !== id);
      }
      return true;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const count = this.tasks.size;
      this.tasks.clear();
      return count;
    });
  }

  deleteFileIfEmpty(): boolean {
    if (!this.filePath || this.tasks.size > 0) return false;
    try { unlinkSync(this.filePath); } catch { /* ignore */ }
    return true;
  }

  clearCompleted(): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, task] of this.tasks) {
        if (task.status === "completed") {
          this.tasks.delete(id);
          count++;
        }
      }
      if (count > 0) {
        const validIds = new Set(this.tasks.keys());
        for (const t of this.tasks.values()) {
          t.blocks = t.blocks.filter(bid => validIds.has(bid));
          t.blockedBy = t.blockedBy.filter(bid => validIds.has(bid));
        }
      }
      return count;
    });
  }
}
