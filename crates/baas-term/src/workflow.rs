//! Workflow graph builder for terminal task sessions.

use crate::types::{TaskSpec, WorkflowEdge, WorkflowNode, WorkflowPlan};

/// A builder for a serial/parallel terminal workflow graph.
#[derive(Default)]
pub struct WorkflowBuilder {
    tasks: Vec<TaskTemplate>,
    edges: Vec<WorkflowEdge>,
    last_stage: Vec<String>,
    next_stage: u8,
}

#[derive(Clone)]
struct TaskTemplate {
    task_id: String,
    region_id: String,
    stage: u8,
    lane: u8,
    name: String,
    description: String,
    command: String,
    running_region_max_lines: Option<usize>,
}

impl WorkflowBuilder {
    /// Creates an empty workflow builder.
    pub fn new() -> Self {
        Self::default()
    }

    /// Adds one serial thread task.
    pub fn thread_task(
        mut self,
        task_id: &str,
        region_id: &str,
        name: &str,
        description: &str,
        command: &str,
    ) -> Self {
        self.push_stage(vec![TaskTemplate::new(
            task_id,
            region_id,
            name,
            description,
            command,
        )]);
        self
    }

    /// Adds one serial process task.
    pub fn process_task(
        mut self,
        task_id: &str,
        region_id: &str,
        name: &str,
        description: &str,
        command: &str,
    ) -> Self {
        self.push_stage(vec![TaskTemplate::new(
            task_id,
            region_id,
            name,
            description,
            command,
        )]);
        self
    }

    /// Adds several tasks as consecutive serial stages.
    pub fn serial(mut self, tasks: Vec<WorkflowTask>) -> Self {
        for task in tasks {
            self.push_stage(vec![TaskTemplate::from_workflow_task(task)]);
        }
        self
    }

    /// Adds a parallel task stage.
    pub fn parallel(mut self, tasks: Vec<WorkflowTask>) -> Self {
        self.push_stage(
            tasks
                .into_iter()
                .map(TaskTemplate::from_workflow_task)
                .collect(),
        );
        self
    }

    /// Adds one task after specific dependency task ids.
    ///
    /// This is useful for branch-shaped workflows where one lane continues while
    /// another lane is still running.
    pub fn task_after(mut self, dependencies: &[&str], task: WorkflowTask) -> Self {
        let stage = dependencies
            .iter()
            .filter_map(|task_id| self.find_task(task_id).map(|task| task.stage))
            .max()
            .unwrap_or_else(|| self.next_stage.saturating_sub(1))
            .saturating_add(1);
        let lane = dependencies
            .first()
            .and_then(|task_id| self.find_task(task_id).map(|task| task.lane))
            .unwrap_or(0);
        let template = TaskTemplate {
            task_id: task.task_id,
            region_id: task.region_id,
            stage,
            lane,
            name: task.name,
            description: task.description,
            command: task.command,
            running_region_max_lines: task.running_region_max_lines,
        };
        for dependency in dependencies {
            self.edges.push(WorkflowEdge {
                from: (*dependency).to_string(),
                to: template.task_id.clone(),
            });
        }
        self.next_stage = self.next_stage.max(stage.saturating_add(1));
        self.last_stage = vec![template.task_id.clone()];
        self.tasks.push(template);
        self
    }

    /// Builds the workflow plan with stable numbering and graph edges.
    pub fn build(mut self) -> WorkflowPlan {
        self.tasks
            .sort_by_key(|task| (task.stage, task.lane, task.task_id.clone()));
        let step_total = self.tasks.len().min(u8::MAX as usize) as u8;
        let nodes = self
            .tasks
            .into_iter()
            .enumerate()
            .map(|(index, task)| WorkflowNode {
                task_id: task.task_id,
                region_id: task.region_id,
                step_index: (index + 1).min(u8::MAX as usize) as u8,
                step_total,
                stage: task.stage,
                lane: task.lane,
                name: task.name,
                description: task.description,
                command: task.command,
                running_region_max_lines: task.running_region_max_lines,
            })
            .collect();
        WorkflowPlan {
            nodes,
            edges: self.edges,
        }
    }

    fn push_stage(&mut self, mut tasks: Vec<TaskTemplate>) {
        let stage = self.next_stage;
        let current_ids = tasks
            .iter()
            .map(|task| task.task_id.clone())
            .collect::<Vec<_>>();
        for from in &self.last_stage {
            for to in &current_ids {
                self.edges.push(WorkflowEdge {
                    from: from.clone(),
                    to: to.clone(),
                });
            }
        }
        for (lane, task) in tasks.iter_mut().enumerate() {
            task.stage = stage;
            task.lane = lane.min(u8::MAX as usize) as u8;
        }
        self.tasks.extend(tasks);
        self.last_stage = current_ids;
        self.next_stage = self.next_stage.saturating_add(1);
    }

    fn find_task(&self, task_id: &str) -> Option<&TaskTemplate> {
        self.tasks.iter().find(|task| task.task_id == task_id)
    }
}

/// Template for one task inside a parallel workflow stage.
pub struct WorkflowTask {
    task_id: String,
    region_id: String,
    name: String,
    description: String,
    command: String,
    running_region_max_lines: Option<usize>,
}

impl WorkflowTask {
    /// Creates a task template.
    pub fn new(
        task_id: &str,
        region_id: &str,
        name: &str,
        description: &str,
        command: &str,
    ) -> Self {
        Self {
            task_id: task_id.to_string(),
            region_id: region_id.to_string(),
            name: name.to_string(),
            description: description.to_string(),
            command: command.to_string(),
            running_region_max_lines: None,
        }
    }

    /// Sets the maximum number of recent output lines shown while this task is running.
    pub fn with_running_region_max_lines(mut self, max_lines: usize) -> Self {
        self.running_region_max_lines = Some(max_lines.max(1));
        self
    }
}

impl TaskTemplate {
    fn new(task_id: &str, region_id: &str, name: &str, description: &str, command: &str) -> Self {
        Self {
            task_id: task_id.to_string(),
            region_id: region_id.to_string(),
            stage: 0,
            lane: 0,
            name: name.to_string(),
            description: description.to_string(),
            command: command.to_string(),
            running_region_max_lines: None,
        }
    }

    fn from_workflow_task(task: WorkflowTask) -> Self {
        Self {
            task_id: task.task_id,
            region_id: task.region_id,
            stage: 0,
            lane: 0,
            name: task.name,
            description: task.description,
            command: task.command,
            running_region_max_lines: task.running_region_max_lines,
        }
    }
}

/// Builds a task spec using numbering from a workflow plan.
pub fn thread_task_spec(plan: &WorkflowPlan, task_id: &str) -> Option<TaskSpec> {
    plan.node(task_id).map(|node| TaskSpec {
        task_id: node.task_id.clone(),
        region_id: node.region_id.clone(),
        step_index: node.step_index,
        step_total: node.step_total,
        name: node.name.clone(),
        command: node.command.clone(),
        program: String::new(),
        args: Vec::new(),
        cwd: ".".to_string(),
        env: Vec::new(),
        after: Vec::new(),
        running_region_max_lines: node.running_region_max_lines,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builder_numbers_serial_and_parallel_tasks() {
        let plan = WorkflowBuilder::new()
            .thread_task("config", "config", "Config", "load config", "config")
            .parallel(vec![
                WorkflowTask::new("main", "main", "Main", "sync main", "git"),
                WorkflowTask::new("cpp", "cpp", "Cpp", "sync cpp", "git"),
            ])
            .process_task("sync", "sync", "Sync", "sync deps", "uv sync")
            .build();

        assert_eq!(plan.nodes.len(), 4);
        assert_eq!(plan.node("config").unwrap().step_total, 4);
        assert_eq!(plan.node("main").unwrap().stage, 1);
        assert_eq!(plan.node("cpp").unwrap().lane, 1);
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "config" && edge.to == "main")
        );
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "cpp" && edge.to == "sync")
        );
    }

    #[test]
    fn builder_supports_branch_continuation_dependencies() {
        let plan = WorkflowBuilder::new()
            .thread_task("config", "config", "Config", "load config", "config")
            .parallel(vec![
                WorkflowTask::new("repo", "repo", "Repo", "sync repo", "git"),
                WorkflowTask::new("uv", "uv", "UV", "install uv", "uv"),
            ])
            .task_after(
                &["uv"],
                WorkflowTask::new("python", "python", "Python", "install python", "uv python"),
            )
            .task_after(
                &["repo", "python"],
                WorkflowTask::new("finalize", "finalize", "Finalize", "finish", "finalize"),
            )
            .build();

        assert_eq!(
            plan.node("repo").unwrap().stage,
            plan.node("uv").unwrap().stage
        );
        assert_eq!(
            plan.node("python").unwrap().stage,
            plan.node("uv").unwrap().stage + 1
        );
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "repo" && edge.to == "finalize")
        );
        assert!(
            plan.edges
                .iter()
                .any(|edge| edge.from == "python" && edge.to == "finalize")
        );
    }
}
