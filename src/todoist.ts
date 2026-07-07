/**
 * Todoist integration module
 */

import { TodoistApi } from '@doist/todoist-sdk';
import { Task, TodoistTask, TodoistProject } from './types';
import { CONSTANTS } from './constants';
import { TaskModel } from './models';

export class TodoistIntegration {
  private api: TodoistApi;
  private apiToken: string;

  constructor(apiToken: string) {
    this.api = new TodoistApi(apiToken);
    this.apiToken = apiToken;
  }

  /**
   * Map a raw v1 SDK task (camelCase) to our internal snake_case TodoistTask shape.
   */
  private mapSdkTask(item: any): TodoistTask {
    return {
      id: item.id,
      content: item.content,
      description: item.description || '',
      project_id: item.projectId,
      section_id: item.sectionId,
      parent_id: item.parentId,
      labels: item.labels || [],
      priority: item.priority,
      is_completed: item.checked,
      completed_at: item.completedAt
        ? (item.completedAt instanceof Date ? item.completedAt.toISOString() : item.completedAt)
        : undefined,
      created_at: item.addedAt
        ? (item.addedAt instanceof Date ? item.addedAt.toISOString() : item.addedAt)
        : undefined,
      updated_at: item.updatedAt
        ? (item.updatedAt instanceof Date ? item.updatedAt.toISOString() : item.updatedAt)
        : undefined,
      due: item.due
        ? {
            date: item.due.date,
            string: item.due.string,
            lang: item.due.lang,
            is_recurring: item.due.isRecurring,
          }
        : undefined,
    } as TodoistTask;
  }

  /**
   * Map a raw v1 SDK project (camelCase) to our internal snake_case TodoistProject shape.
   */
  private mapSdkProject(project: any): TodoistProject {
    return {
      id: project.id,
      name: project.name,
      parent_id: project.parentId,
      order: project.childOrder,
      color: project.color,
    };
  }

  /**
   * Fetch all projects from Todoist
   */
  async getAllProjects(): Promise<TodoistProject[]> {
    console.log('Fetching all projects from Todoist...');
    const projects: TodoistProject[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.api.getProjects(cursor ? { cursor } : {});
      projects.push(...response.results.map((p: any) => this.mapSdkProject(p)));
      cursor = response.nextCursor;
    } while (cursor);
    console.log(`Retrieved ${projects.length} projects`);
    return projects;
  }

  /**
   * Build project hierarchy
   */
  async getProjectHierarchy(): Promise<{
    projects: Map<string, TodoistProject & { children: string[]; hasTasks: boolean; isLeaf: boolean }>;
    roots: string[];
  }> {
    const projects = await this.getAllProjects();

    const projectMap = new Map<string, TodoistProject & { children: string[]; hasTasks: boolean; isLeaf: boolean }>();

    for (const project of projects) {
      projectMap.set(project.id, {
        ...project,
        children: [],
        hasTasks: false,
        isLeaf: true,
      });
    }

    // Build hierarchy
    const roots: string[] = [];
    for (const project of projects) {
      if (project.parent_id && projectMap.has(project.parent_id)) {
        projectMap.get(project.parent_id)!.children.push(project.id);
      } else {
        roots.push(project.id);
      }
    }

    // Mark leaf status
    for (const [id, project] of projectMap) {
      if (project.children.length > 0) {
        project.isLeaf = false;
      }
    }

    return { projects: projectMap, roots };
  }

  /**
   * Fetch tasks using the unified v1 sync endpoint (incremental updates)
   */
  async syncTasks(syncToken: string = '*'): Promise<{ items: any[]; syncToken: string; fullSync: boolean }> {
    console.log('Syncing tasks from Todoist using Sync API...');

    try {
      const response = await this.api.sync({
        syncToken,
        resourceTypes: ['items', 'projects'],
      });

      const items = response.items || [];
      const newSyncToken = response.syncToken || syncToken;
      const fullSync = response.fullSync || false;

      console.log(`  Retrieved ${items.length} items (full_sync: ${fullSync})`);

      return {
        items,
        syncToken: newSyncToken,
        fullSync
      };
    } catch (error) {
      console.error('Error syncing with Todoist:', error);
      throw error;
    }
  }

  /**
   * Convert Sync API items to TodoistTask format
   */
  convertSyncItemsToTasks(items: any[]): TodoistTask[] {
    return items
      .filter(item => !item.isDeleted)
      .filter(item => {
        // Exclude tasks with the nosync label
        if (Array.isArray(item.labels)) {
          return !item.labels.includes(CONSTANTS.NOSYNC_TAG);
        }
        return true;
      })
      .map(item => this.mapSdkTask(item));
  }

  /**
   * Fetch all tasks (including completed) - Legacy method kept for compatibility
   */
  async getAllTasks(includeCompleted: boolean = true): Promise<TodoistTask[]> {
    console.log('Fetching all tasks from Todoist...');

    const allTasks: TodoistTask[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.api.getTasks(cursor ? { cursor } : {});
      allTasks.push(...response.results.map((t: any) => this.mapSdkTask(t)));
      cursor = response.nextCursor;
    } while (cursor);

    // Filter out tasks with the nosync label
    const filteredTasks = allTasks.filter(task => {
      if (Array.isArray(task.labels)) {
        return !task.labels.includes(CONSTANTS.NOSYNC_TAG);
      }
      return true;
    });
    console.log(`Retrieved ${filteredTasks.length} tasks (filtered)`);
    return filteredTasks;
  }

  /**
   * Get tasks for a specific project
   */
  async getTasksForProject(projectId: string): Promise<TodoistTask[]> {
    console.log(`Fetching tasks for project ${projectId}...`);
    const tasks: TodoistTask[] = [];
    let cursor: string | null = null;
    do {
      const response = await this.api.getTasks(cursor ? { projectId, cursor } : { projectId });
      tasks.push(...response.results.map((t: any) => this.mapSdkTask(t)));
      cursor = response.nextCursor;
    } while (cursor);
    return tasks;
  }

  /**
   * Translate our internal snake_case task payload into the v1 SDK's camelCase args.
   */
  private toSdkTaskArgs(data: any): any {
    const args: any = {};
    if (data.content !== undefined) args.content = data.content;
    if (data.description !== undefined) args.description = data.description;
    if (data.due_string !== undefined) args.dueString = data.due_string;
    if (data.labels !== undefined) args.labels = data.labels;
    if (data.project_id !== undefined) args.projectId = data.project_id;
    return args;
  }

  /**
   * Create a new task in Todoist
   */
  async createTask(task: Task): Promise<TodoistTask> {
    // Validate task has a non-empty title
    if (!task.title || task.title.trim() === '') {
      throw new Error(`Cannot create task with empty title. Task ID: ${task.craftId || task.id}`);
    }

    console.log(`Creating task in Todoist: ${task.title}`);

    const taskData = TaskModel.toTodoist(task);
    const sdkArgs = this.toSdkTaskArgs(taskData);
    console.log(`  Task data being sent:`, JSON.stringify(sdkArgs, null, 2));

    try {
      const createdTask = await this.api.addTask(sdkArgs);
      console.log(`Task created with ID: ${createdTask.id}`);
      return this.mapSdkTask(createdTask);
    } catch (error: any) {
      console.error(`  Failed with data:`, JSON.stringify(sdkArgs, null, 2));
      console.error(`  Error details:`, error.message, error.responseData);
      throw error;
    }
  }

  /**
   * Update an existing task
   */
  async updateTask(task: Task): Promise<TodoistTask> {
    if (!task.todoistId) {
      throw new Error('Task must have todoistId to update');
    }

    console.log(`Updating Todoist task ${task.todoistId}: ${task.title}`);

    const taskData = TaskModel.toTodoist(task);
    const sdkArgs = this.toSdkTaskArgs(taskData);
    const updatedTask = await this.api.updateTask(task.todoistId, sdkArgs);

    return this.mapSdkTask(updatedTask);
  }

  /**
   * Complete a task
   */
  async completeTask(todoistId: string): Promise<boolean> {
    console.log(`Completing Todoist task ${todoistId}`);

    try {
      await this.api.closeTask(todoistId);
      return true;
    } catch (error) {
      console.error(`Failed to complete task ${todoistId}:`, error);
      return false;
    }
  }

  /**
   * Reopen a completed task
   */
  async reopenTask(todoistId: string): Promise<boolean> {
    console.log(`Reopening Todoist task ${todoistId}`);

    try {
      await this.api.reopenTask(todoistId);
      return true;
    } catch (error) {
      console.error(`Failed to reopen task ${todoistId}:`, error);
      return false;
    }
  }

  /**
   * Delete a task
   */
  async deleteTask(todoistId: string): Promise<boolean> {
    console.log(`Deleting Todoist task ${todoistId}`);

    try {
      await this.api.deleteTask(todoistId);
      return true;
    } catch (error) {
      console.error(`Failed to delete task ${todoistId}:`, error);
      return false;
    }
  }

  /**
   * Convert Todoist tasks to Task objects
   */
  convertToTaskObjects(todoistTasks: TodoistTask[]): Task[] {
    const tasks: Task[] = [];
    let skippedEmptyTasks = 0;

    for (const todoistTask of todoistTasks) {
      try {
        const task = TaskModel.fromTodoist(todoistTask);

        // Validate task has a non-empty title
        if (!task.title || task.title.trim() === '') {
          skippedEmptyTasks++;
          continue;
        }

        tasks.push(task);
      } catch (error) {
        console.error(`Failed to convert Todoist task ${todoistTask.id}:`, error);
      }
    }

    if (skippedEmptyTasks > 0) {
      console.log(`  ⚠ Skipped ${skippedEmptyTasks} tasks with empty titles from Todoist`);
    }

    return tasks;
  }

  /**
   * Mark which projects have tasks
   */
  markProjectsWithTasks(
    projectHierarchy: ReturnType<typeof this.getProjectHierarchy> extends Promise<infer T> ? T : never,
    tasks: TodoistTask[]
  ): void {
    for (const task of tasks) {
      if (task.project_id && projectHierarchy.projects.has(task.project_id)) {
        projectHierarchy.projects.get(task.project_id)!.hasTasks = true;
      }
    }
  }
}
