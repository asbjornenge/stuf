import React, { useEffect, useState, useMemo, useRef, useCallback, useImperativeHandle, forwardRef } from 'react';
import styled from 'styled-components';
import { AnimatePresence, motion } from 'framer-motion';
import { initCRDT, getDocument, addTask, updateTask, deleteTask, updateTaskOrder, getGlobalTags, addGlobalTag, deleteGlobalTag, getRecentTags, updateRecentTags, getProjects, addProject, deleteProject, getSettings, updateSettings } from '../utils/crdt';
import { initSync, teardownSync, isSyncing } from '../utils/sync';
import { registerReminder, cancelReminder, subscribeToPush } from '../utils/push';
import { toPlainTask } from '../utils/task';
import { useDoubleTap } from '../utils/useDoubleTap';
import Sync from './Sync';
import Settings from './Settings';
import Toast from './Toast';
import TaskListItem from './TaskListItem';
import SearchModal from './SearchModal';
import SnoozePicker from './SnoozePicker';
import RuneIcon from './RuneIcon';
import { CirclePlus, Search, ChevronLeft, Tag, Settings as SettingsIcon, Calendar, Scroll } from 'lucide-react';
import { colors } from '../theme';

const slideVariants = {
  enter: (direction) => ({
    x: direction > 0 ? '100%' : '-30%',
    opacity: direction > 0 ? 1 : 0.5,
    zIndex: direction > 0 ? 2 : 0,
  }),
  center: {
    x: 0,
    opacity: 1,
    zIndex: 1,
  },
  exit: (direction) => ({
    x: direction > 0 ? '-30%' : '100%',
    opacity: direction > 0 ? 0.5 : 1,
    zIndex: direction > 0 ? 0 : 2,
  }),
};

const pageTransition = {
  duration: 0.3,
  ease: [0.25, 0.1, 0.25, 1],
};

export default forwardRef(function TaskList(props, ref) {
  const [tasks, setTasks] = useState([]);
  const [appReady, setAppReady] = useState(false);
  const [editingTaskId, setEditingTaskId] = useState(null);
  const [addButtonAnimating, setAddButtonAnimating] = useState(false);
  const [isSyncOpen, setIsSyncOpen] = useState(false);
  const [isBackupOpen, setIsBackupOpen] = useState(false);
  const [isSupportOpen, setIsSupportOpen] = useState(false);
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [draggedTaskId, setDraggedTaskId] = useState(null);
  const [recentlyCompleted, setRecentlyCompleted] = useState(new Set());
  const [fullscreenTaskId, setFullscreenTaskId] = useState(null);
  const [snoozePickerTaskId, setSnoozePickerTaskId] = useState(null);
  const [fullscreenStartRect, setFullscreenStartRect] = useState(null);
  const [availableTags, setAvailableTags] = useState([]);
  const [activeView, setActiveView] = useState('stof'); // 'stof' | 'log'
  const [logDays, setLogDays] = useState(30);
  const [activeTagFilter, setActiveTagFilter] = useState(null);
  const [showNavMenu, setShowNavMenu] = useState(false);
  const [recentTags, setRecentTags] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [newProjectInput, setNewProjectInput] = useState('');
  const [showNewProjectInput, setShowNewProjectInput] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [settings, setSettings] = useState({ morningHour: 9, eveningHour: 17, somedayMinDays: 10, somedayMaxDays: 60 });
  const [navDirection, setNavDirection] = useState(1);
  const [toast, setToast] = useState(null); // { message, type }
  const toastTimer = useRef(null);

  const showToast = useCallback((message, type = 'error', duration = 4000) => {
    setToast({ message, type });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), duration);
  }, []);

  useImperativeHandle(ref, () => ({
    onCheckoutComplete: () => {
      showToast('Purchase complete! Sync is now active.', 'success', 5000);
      setIsSyncOpen(true);
    },
    onRenewComplete: () => {
      showToast('Subscription renewed! Sync is active again.', 'success', 5000);
      setIsSyncOpen(true);
    },
  }), [showToast]);

  const pushRecentTag = async (tagName) => {
    const updated = [tagName, ...recentTags.filter(t => t !== tagName)].slice(0, 3);
    setRecentTags(updated);
    const change = await updateRecentTags(updated);

  };
  const taskRefs = useRef({});
  const longPressTimer = useRef(null);
  const completionTimers = useRef({});

  // Filter tasks based on active view
  const filteredTasks = useMemo(() => {
    const now = Date.now();

    if (activeView === 'log') {
      const cutoff = Date.now() - logDays * 86400000;
      return tasks.filter(task => task.completed && task.name && (!task.completedAt || task.completedAt >= cutoff));
    }

    if (activeView === 'upcoming') {
      return tasks.filter(task => !task.completed && task.snoozeUntil && task.snoozeUntil > now);
    }

    // For stof, project, and tag views: exclude snoozed tasks
    const completionFiltered = tasks.filter(task =>
      (!task.completed || recentlyCompleted.has(task.id)) &&
      (!task.snoozeUntil || task.snoozeUntil <= now)
    );
    if (activeTagFilter) {
      return completionFiltered.filter(task => task.tags && task.tags.includes(activeTagFilter));
    }
    if (activeProjectId) {
      return completionFiltered.filter(task => task.projectId === activeProjectId);
    }
    // stꝋf default: tasks without a project
    return completionFiltered.filter(task => !task.projectId);
  }, [tasks, activeView, activeTagFilter, activeProjectId, recentlyCompleted]);

  // Sort: tasks without order first (newest first), then by order
  const sortedTasks = useMemo(() => [...filteredTasks].sort((a, b) => {
    if (activeView === 'log') {
      const aTime = a.completedAt || 0;
      const bTime = b.completedAt || 0;
      return bTime - aTime;
    }
    if (activeView === 'upcoming') {
      return (a.snoozeUntil || 0) - (b.snoozeUntil || 0);
    }
    if (a.order == null && b.order == null) return b.id - a.id;
    if (a.order == null) return -1;
    if (b.order == null) return 1;
    return a.order - b.order;
  }), [filteredTasks, activeView]);

  // Group log tasks by completion date
  const logGroups = useMemo(() => {
    if (activeView !== 'log') return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    const groups = [];
    let currentLabel = null;
    let currentTasks = [];

    for (const task of sortedTasks) {
      let label;
      if (!task.completedAt) {
        label = 'Earlier';
      } else {
        const d = new Date(task.completedAt);
        d.setHours(0, 0, 0, 0);
        if (d.getTime() === today.getTime()) {
          label = 'Today';
        } else if (d.getTime() === yesterday.getTime()) {
          label = 'Yesterday';
        } else {
          label = d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
        }
      }

      if (label !== currentLabel) {
        if (currentTasks.length > 0) {
          groups.push({ label: currentLabel, tasks: currentTasks });
        }
        currentLabel = label;
        currentTasks = [task];
      } else {
        currentTasks.push(task);
      }
    }
    if (currentTasks.length > 0) {
      groups.push({ label: currentLabel, tasks: currentTasks });
    }
    return groups;
  }, [sortedTasks, activeView]);

  // Group upcoming tasks by snooze date
  const upcomingGroups = useMemo(() => {
    if (activeView !== 'upcoming') return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const groups = [];
    let currentLabel = null;
    let currentTasks = [];

    for (const task of sortedTasks) {
      const d = new Date(task.snoozeUntil);
      d.setHours(0, 0, 0, 0);
      let label;
      if (d.getTime() === today.getTime()) {
        label = 'Today';
      } else if (d.getTime() === tomorrow.getTime()) {
        label = 'Tomorrow';
      } else {
        label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'long', day: 'numeric' });
      }

      if (label !== currentLabel) {
        if (currentTasks.length > 0) {
          groups.push({ label: currentLabel, tasks: currentTasks });
        }
        currentLabel = label;
        currentTasks = [task];
      } else {
        currentTasks.push(task);
      }
    }
    if (currentTasks.length > 0) {
      groups.push({ label: currentLabel, tasks: currentTasks });
    }
    return groups;
  }, [sortedTasks, activeView]);

  const refreshFromDoc = useCallback(() => {
    const docTodos = getDocument().todos || [];
    setTasks(prev => {
      const newTasks = docTodos.map(t => toPlainTask(t));
      let changed = prev.length !== newTasks.length;
      const merged = newTasks.map(nt => {
        const old = prev.find(ot => ot.id === nt.id);
        if (old && old.updated === nt.updated && old.completed === nt.completed && old.order === nt.order && old.projectId === nt.projectId && old.name === nt.name && old.snoozeUntil === nt.snoozeUntil) {
          return old;
        }
        changed = true;
        return nt;
      });
      return changed ? merged : prev;
    });
    setAvailableTags(getGlobalTags());
    setRecentTags(getRecentTags());
    setProjects(getProjects());
    setSettings(getSettings());
  }, []);

  const handleSyncError = useCallback((context, message) => {
    showToast(`Sync failed: ${message}`, 'error', 6000);
  }, [showToast]);

  useEffect(() => {
    const initialize = async () => {
      const MIN_LOADING_MS = 700;
      const startTime = Date.now();
      await initCRDT();
      refreshFromDoc();
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, MIN_LOADING_MS - elapsed);
      setTimeout(() => setAppReady(true), remaining);
      await initSync(refreshFromDoc, handleSyncError);
      // Subscribe to push notifications if syncing
      if (isSyncing()) {
        try { await subscribeToPush(); } catch (e) { console.warn('Push subscribe:', e); }
      }
    };
    initialize();

    // Periodic check for expired snoozes (every 60 seconds)
    const snoozeInterval = setInterval(() => {
      const now = Date.now();
      setTasks(prev => {
        const hasExpired = prev.some(t => t.snoozeUntil && t.snoozeUntil <= now);
        return hasExpired ? [...prev] : prev;
      });
    }, 60000);

    // Cleanup timers on unmount
    return () => {
      teardownSync();
      clearInterval(snoozeInterval);
      if (toastTimer.current) clearTimeout(toastTimer.current);
      Object.values(completionTimers.current).forEach(timer => clearTimeout(timer));
    };
  }, []);

  // Local state for drag reordering (before saving to CRDT)
  const [localTaskOrder, setLocalTaskOrder] = useState(null);
  const displayTasks = localTaskOrder || sortedTasks;

  const handleLongPressStart = (e, taskId) => {
    if (editingTaskId !== null) return;
    if (activeTagFilter) return;
    if (activeView === 'log' || activeView === 'upcoming') return;

    longPressTimer.current = setTimeout(() => {
      window.getSelection()?.removeAllRanges();
      setDraggedTaskId(taskId);
      setLocalTaskOrder([...sortedTasks]);
    }, 500);
  };

  const handleLongPressEnd = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };

  const handleContextMenu = (e) => {
    if (longPressTimer.current || draggedTaskId !== null) {
      e.preventDefault();
    }
  };

  const handleDragMove = (e) => {
    if (draggedTaskId === null || !localTaskOrder) return;

    const y = e.clientY ?? e.touches?.[0]?.clientY;
    if (y === undefined) return;

    // Find which task we're over
    for (const task of localTaskOrder) {
      if (task.id === draggedTaskId) continue;
      const el = taskRefs.current[task.id];
      if (el) {
        const rect = el.getBoundingClientRect();
        if (y >= rect.top && y <= rect.bottom) {
          const dragIndex = localTaskOrder.findIndex(t => t.id === draggedTaskId);
          const targetIndex = localTaskOrder.findIndex(t => t.id === task.id);

          if (dragIndex !== targetIndex) {
            const newOrder = [...localTaskOrder];
            const [removed] = newOrder.splice(dragIndex, 1);
            newOrder.splice(targetIndex, 0, removed);
            setLocalTaskOrder(newOrder);
          }
          break;
        }
      }
    }
  };

  const handleDragEnd = async () => {
    if (draggedTaskId !== null) {
      wasDraggingRef.current = true;
    }
    if (localTaskOrder) {
      // Save the new order to CRDT
      const taskUpdates = localTaskOrder.map((task, index) => ({
        id: task.id,
        order: index
      }));

      const change = await updateTaskOrder(taskUpdates);
      refreshFromDoc();
    }
    setDraggedTaskId(null);
    setLocalTaskOrder(null);
  };

  useEffect(() => {
    if (draggedTaskId === null) return;

    const handleMove = (e) => handleDragMove(e);
    const handleEnd = () => handleDragEnd();

    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
    document.body.style.touchAction = 'none';

    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleEnd);
    document.addEventListener('touchmove', handleMove, { passive: false });
    document.addEventListener('touchend', handleEnd);

    return () => {
      document.body.style.userSelect = '';
      document.body.style.webkitUserSelect = '';
      document.body.style.touchAction = '';
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleEnd);
      document.removeEventListener('touchmove', handleMove);
      document.removeEventListener('touchend', handleEnd);
    };
  }, [draggedTaskId, localTaskOrder]);


  // Save task (create or update)
  const handleSaveTask = async (updatedTask) => {
    const existingTask = tasks.find(t => t.id === updatedTask.id);

    if (existingTask) {
      await updateTask(updatedTask.id, updatedTask);
    } else {
      await addTask(updatedTask);
    }

    refreshFromDoc();
  };

  const handleAddGlobalTag = async (name) => {
    const change = await addGlobalTag(name);

    setAvailableTags(getGlobalTags());
  };

  const handleDeleteGlobalTag = async (name) => {
    const change = await deleteGlobalTag(name);

    setAvailableTags(getGlobalTags());
  };

  const handleAddProject = async (name) => {
    const change = await addProject(name);

    setProjects(getProjects());
  };

  const handleDeleteProject = async (id) => {
    const change = await deleteProject(id);

    setProjects(getProjects());
    setActiveProjectId(null);
    setNavDirection(-1);
    setShowNavMenu(true);
  };

  const handleSnooze = async (snoozeUntil, reminder, taskId, taskName) => {
    if (!isSyncing()) return;
    try {
      if (reminder) {
        await registerReminder(taskId, taskName, reminder);
      } else {
        await cancelReminder(taskId);
      }
    } catch (err) {
      console.warn('Reminder registration failed:', err);
    }
  };

  // Show delete bar when viewing a project with no active tasks
  const projectCanDelete = activeProjectId && !tasks.some(t => t.projectId === activeProjectId && !t.completed);

  // Proxy input for iOS Safari focus — must focus synchronously in click handler
  const proxyInputRef = useRef(null);

  // Create new task and start editing it
  const handleAddNewTask = async () => {
    // Focus proxy input immediately in click gesture chain (iOS requirement)
    proxyInputRef.current?.focus();
    addButtonArrivedRef.current = false;
    setAddButtonAnimating('up');
  };

  const addButtonArrivedRef = useRef(false);

  const handleAddButtonArrived = async (e) => {
    if (e.propertyName !== 'bottom' || addButtonAnimating !== 'up' || addButtonArrivedRef.current) return;
    addButtonArrivedRef.current = true;
    const now = Date.now();
    const newTask = { id: now, name: '', completed: false, created: now, updated: now };
    if (activeProjectId) {
      newTask.projectId = activeProjectId;
    }
    const change = await addTask(newTask);
    refreshFromDoc();
    // Let the task mount first, then open edit mode next frame so the animation plays
    requestAnimationFrame(() => {
      setEditingTaskId(newTask.id);
    });
  };

  const handleNavigateToTag = (tagName) => {
    handleCloseEditing();
    setActiveTagFilter(tagName);
    pushRecentTag(tagName);
  };

  const wasDraggingRef = useRef(false);

  const handleOpenTask = (task) => {
    handleLongPressEnd();
    if (wasDraggingRef.current) {
      wasDraggingRef.current = false;
      return;
    }
    setEditingTaskId(task.id);
  };

  const randomToastSamples = [
    { message: 'Everything is fine!', type: 'success' },
    { message: 'Something went wrong.', type: 'error' },
    { message: 'Task saved successfully.', type: 'success' },
    { message: 'Failed to sync with server.', type: 'error' },
    { message: 'Reminder set for tomorrow.', type: 'success' },
  ];
  const handleRandomToast = useCallback(() => {
    const { message, type } = randomToastSamples[Math.floor(Math.random() * randomToastSamples.length)];
    showToast(message, type);
  }, [showToast]);

  const doubleTapProps = useDoubleTap(handleRandomToast);

  const handleCloseEditing = () => {
    if (editingTaskId !== null) {
      if (addButtonAnimating === 'up') {
        // Coming from "add new" — snap below screen instantly, then animate up
        setAddButtonAnimating('snap-down');
        setEditingTaskId(null);
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setAddButtonAnimating(false);
          });
        });
      } else {
        setAddButtonAnimating('none');
        setEditingTaskId(null);
        setTimeout(() => setAddButtonAnimating(false), 50);
      }
    }
  };

  const handleToggleComplete = async (id) => {
    const task = tasks.find(t => t.id === id);
    if (task) {
      const nowCompleted = !task.completed;
      const updatedTask = toPlainTask(task);
      updatedTask.completed = nowCompleted;
      updatedTask.updated = Date.now();
      if (nowCompleted) {
        updatedTask.completedAt = Date.now();
      } else {
        updatedTask.completedAt = undefined;
      }
      await updateTask(id, updatedTask);
      refreshFromDoc();

      if (nowCompleted) {
        // Add to recently completed - task stays visible for 3 seconds
        setRecentlyCompleted(prev => new Set(prev).add(id));

        // Clear any existing timer for this task
        if (completionTimers.current[id]) {
          clearTimeout(completionTimers.current[id]);
        }

        // After 3 seconds, remove from recentlyCompleted — AnimatePresence handles the exit animation
        completionTimers.current[id] = setTimeout(() => {
          setRecentlyCompleted(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          delete completionTimers.current[id];
        }, 3000);
      } else {
        // Undo - cancel timer and remove from set immediately
        if (completionTimers.current[id]) {
          clearTimeout(completionTimers.current[id]);
          delete completionTimers.current[id];
        }
        setRecentlyCompleted(prev => {
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    }
  };


  // Close editing if task no longer exists in list
  useEffect(() => {
    if (editingTaskId === null) return;
    const taskExists = filteredTasks.some(t => t.id === editingTaskId);
    if (!taskExists) {
      handleCloseEditing();
    }
  }, [filteredTasks, editingTaskId]);

  // Global escape key listener
  useEffect(() => {
    if (editingTaskId === null) return;

    const handleEscapeKey = (e) => {
      if (e.key === 'Escape') {
        handleCloseEditing();
      }
    };

    document.addEventListener('keydown', handleEscapeKey);
    return () => document.removeEventListener('keydown', handleEscapeKey);
  }, [editingTaskId]);

  // Determine current page
  let pageKey = 'tasklist';
  let pageContent;

  if (isSupportOpen) {
    pageKey = 'support';
    pageContent = (
      <ContentWrapper>
        <Settings
          view="support"
          onBack={() => { setNavDirection(-1); setIsSupportOpen(false); setIsSettingsOpen(true); }}
        />
      </ContentWrapper>
    );
  } else if (isBackupOpen) {
    pageKey = 'backup';
    pageContent = (
      <ContentWrapper>
        <Settings
          view="backup"
          settings={settings}
          setSettings={setSettings}
          refreshFromDoc={refreshFromDoc}
          showToast={showToast}
          onBack={() => { setNavDirection(-1); setIsBackupOpen(false); setIsSettingsOpen(true); }}
        />
      </ContentWrapper>
    );
  } else if (isSyncOpen) {
    pageKey = 'sync';
    pageContent = (
      <ContentWrapper>
        <TopRow>
          <BackButton onClick={() => { setNavDirection(-1); setIsSyncOpen(false); setIsSettingsOpen(true); }}><ChevronLeft size="2rem" /></BackButton>
          <div style={{ width: '3.25rem' }} />
        </TopRow>
        <Title>Sync</Title>
        <Sync onConnect={() => { setNavDirection(-1); setIsSyncOpen(false); }} onRemoteChanges={refreshFromDoc} />
      </ContentWrapper>
    );
  } else if (isSettingsOpen) {
    pageKey = 'settings';
    pageContent = (
      <ContentWrapper style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <Settings
          view="settings"
          settings={settings}
          setSettings={setSettings}
          refreshFromDoc={refreshFromDoc}
          onBack={() => { setNavDirection(-1); setIsSettingsOpen(false); setShowNavMenu(true); }}
          onOpenSync={() => { setNavDirection(1); setIsSettingsOpen(false); setIsSyncOpen(true); }}
          onOpenBackup={() => { setNavDirection(1); setIsSettingsOpen(false); setIsBackupOpen(true); }}
          onOpenSupport={() => { setNavDirection(1); setIsSettingsOpen(false); setIsSupportOpen(true); }}
        />
      </ContentWrapper>
    );
  } else if (showNavMenu) {
    pageKey = 'nav';
    pageContent = (
      <ContentWrapper style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <TopRow>
          <div style={{ width: '3.25rem' }} />
          <div style={{ width: '3.25rem' }} />
        </TopRow>
        <NavMenu>
          <NavScrollArea>
            <NavItem $active={activeView === 'stof' && !activeTagFilter && !activeProjectId} onClick={() => { setNavDirection(1); setActiveView('stof'); setActiveTagFilter(null); setActiveProjectId(null); setShowNavMenu(false); handleCloseEditing(); }}>
              <NavIcon><RuneIcon /></NavIcon>stꝋf
            </NavItem>
            <NavItem $active={activeView === 'upcoming'} onClick={() => { setNavDirection(1); setActiveView('upcoming'); setActiveTagFilter(null); setActiveProjectId(null); setShowNavMenu(false); handleCloseEditing(); }}>
              <NavIcon><Calendar size="1.125rem" /></NavIcon>Upcoming
            </NavItem>
            <NavItem $active={activeView === 'log' && !activeTagFilter && !activeProjectId} onClick={() => { setNavDirection(1); setActiveView('log'); setActiveTagFilter(null); setActiveProjectId(null); setShowNavMenu(false); handleCloseEditing(); setLogDays(30); }}>
              <NavIcon><Scroll size="1.125rem" /></NavIcon>Log
            </NavItem>
            <NavDivider />
            {projects.map(project => (
              <NavItem
                key={project.id}
                active={activeProjectId === project.id}
                onClick={() => { setNavDirection(1); setActiveView('stof'); setActiveTagFilter(null); setActiveProjectId(project.id); setShowNavMenu(false); handleCloseEditing(); }}
              >
                <NavIcon>○</NavIcon>{project.name}
              </NavItem>
            ))}
            {showNewProjectInput ? (
              <NavItem as="div">
                <NavIcon>○</NavIcon>
                <NewProjectInput
                  value={newProjectInput}
                  onChange={(e) => setNewProjectInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && newProjectInput.trim()) {
                      handleAddProject(newProjectInput.trim());
                      setNewProjectInput('');
                      setShowNewProjectInput(false);
                    } else if (e.key === 'Escape') {
                      setNewProjectInput('');
                      setShowNewProjectInput(false);
                    }
                  }}
                  placeholder="Project name..."
                  autoFocus
                />
              </NavItem>
            ) : (
              <NavAddButton onClick={() => setShowNewProjectInput(true)}>
                <NavIcon>+</NavIcon>New Project
              </NavAddButton>
            )}
          </NavScrollArea>
          <NavFooter>
            <NavDivider />
            <NavSettingsItem onClick={() => { setNavDirection(1); setShowNavMenu(false); setIsSettingsOpen(true); }}>
              <SettingsIcon size="1em" style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> Settings
            </NavSettingsItem>
          </NavFooter>
        </NavMenu>
      </ContentWrapper>
    );
  } else {
    pageContent = (
      <>
        <ProxyInput ref={proxyInputRef} aria-hidden="true" tabIndex={-1} />
        <ContentWrapper>
          <Header>
            <TopRow $editing={editingTaskId !== null}>
              <BackButton onClick={() => {
                setNavDirection(-1);
                if (activeTagFilter) {
                  setActiveTagFilter(null);
                } else if (activeProjectId) {
                  setActiveProjectId(null);
                  setShowNavMenu(true);
                } else {
                  setShowNavMenu(true);
                }
              }}><ChevronLeft size="2rem" /></BackButton>
              <MenuButton onClick={() => setIsMenuOpen(true)}><Search size="1.5rem" /></MenuButton>
            </TopRow>
            <AnimatePresence>
              {isMenuOpen && (
                <SearchModal
                availableTags={availableTags}
                recentTags={recentTags}
                activeTagFilter={activeTagFilter}
                activeView={activeView}
                activeProjectId={activeProjectId}
                projects={projects}
                tasks={tasks}
                onNavigateToTag={(tag) => {
                  setActiveTagFilter(tag);
                  setActiveView('stof');
                  setActiveProjectId(null);
                  pushRecentTag(tag);
                  handleCloseEditing();
                }}
                onNavigateToView={(view) => { setActiveView(view); setActiveTagFilter(null); setActiveProjectId(null); handleCloseEditing(); }}
                onNavigateToProject={(id) => { setActiveProjectId(id); setActiveView('stof'); setActiveTagFilter(null); handleCloseEditing(); }}
                onOpenTask={(taskId) => {
                  const task = tasks.find(t => t.id === taskId);
                  setActiveTagFilter(null);
                  setActiveProjectId(task?.projectId || null);
                  setActiveView(task?.completed ? 'log' : 'stof');
                  setEditingTaskId(taskId);
                }}
                onClose={() => setIsMenuOpen(false)}
              />
              )}
            </AnimatePresence>
            <Title>{activeTagFilter ? <><Tag size="0.8em" style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> {activeTagFilter}</> : activeView === 'upcoming' ? <><Calendar size="0.8em" style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> Upcoming</> : activeView === 'log' ? <><Scroll size="0.8em" style={{ marginRight: '0.25em', verticalAlign: 'middle' }} /> Log</> : activeProjectId ? `○ ${projects.find(p => p.id === activeProjectId)?.name || ''}` : <><RuneIcon size="0.8em" style={{ marginRight: '0.25em' }} /> stꝋf</>}</Title>
          </Header>
          <TaskListContainer>
            {(activeView === 'log' && logGroups) || (activeView === 'upcoming' && upcomingGroups) ? (
              (activeView === 'log' ? logGroups : upcomingGroups).map((group) => (
                <React.Fragment key={group.label}>
                  <DateGroupHeader>{group.label}</DateGroupHeader>
                  {group.tasks.map((task) => (
                    <TaskListItem
                      key={task.id}
                      task={task}
                      editing={editingTaskId === task.id}
                      fullscreen={fullscreenTaskId === task.id}
                      dragging={draggedTaskId === task.id}
                        onSave={handleSaveTask}
                      onClose={handleCloseEditing}
                      onToggleComplete={() => handleToggleComplete(task.id)}
                      onClick={() => handleOpenTask(task)}
                      onLongPressStart={(e) => handleLongPressStart(e, task.id)}
                      onLongPressEnd={handleLongPressEnd}
                      onContextMenu={handleContextMenu}
                      fullscreenStartRect={fullscreenTaskId === task.id ? fullscreenStartRect : null}
                      onFullscreen={() => {
                        const el = taskRefs.current[task.id];
                        setFullscreenStartRect(el ? el.getBoundingClientRect() : null);
                        setFullscreenTaskId(task.id);
                      }}
                      onExitFullscreen={() => setFullscreenTaskId(null)}
                      availableTags={availableTags}
                      projects={projects}
                      settings={settings}
                      onNavigateToTag={handleNavigateToTag}
                      onAddGlobalTag={handleAddGlobalTag}
                      onDeleteGlobalTag={handleDeleteGlobalTag}
                      onSnooze={handleSnooze}
                      onOpenSnoozePicker={() => setSnoozePickerTaskId(task.id)}
                      itemRef={el => taskRefs.current[task.id] = el}
                    />
                  ))}
                </React.Fragment>
              ))
            ) : (
              <AnimatePresence initial={false}>
                {displayTasks.map((task) => (
                  <TaskListItem
                    key={task.id}
                    task={task}
                    editing={editingTaskId === task.id}
                    fullscreen={fullscreenTaskId === task.id}
                    dragging={draggedTaskId === task.id}
                    onSave={handleSaveTask}
                    onClose={handleCloseEditing}
                    onToggleComplete={() => handleToggleComplete(task.id)}
                    onClick={() => handleOpenTask(task)}
                    onLongPressStart={(e) => handleLongPressStart(e, task.id)}
                    onLongPressEnd={handleLongPressEnd}
                    onContextMenu={handleContextMenu}
                    fullscreenStartRect={fullscreenTaskId === task.id ? fullscreenStartRect : null}
                    onFullscreen={() => {
                      const el = taskRefs.current[task.id];
                      setFullscreenStartRect(el ? el.getBoundingClientRect() : null);
                      setFullscreenTaskId(task.id);
                    }}
                    onExitFullscreen={() => setFullscreenTaskId(null)}
                    availableTags={availableTags}
                    projects={projects}
                    settings={settings}
                    onNavigateToTag={handleNavigateToTag}
                    onAddGlobalTag={handleAddGlobalTag}
                    onDeleteGlobalTag={handleDeleteGlobalTag}
                    onSnooze={handleSnooze}
                    onOpenSnoozePicker={() => setSnoozePickerTaskId(task.id)}
                    itemRef={el => taskRefs.current[task.id] = el}
                  />
                ))}
              </AnimatePresence>
            )}
          </TaskListContainer>
          {activeView === 'log' && tasks.some(t => t.completed && t.name && t.completedAt && t.completedAt < Date.now() - logDays * 86400000) && (
            <LoadMore onClick={() => setLogDays(d => d + 30)}>Load more</LoadMore>
          )}
        </ContentWrapper>
        {projectCanDelete && !editingTaskId && !fullscreenTaskId && (
          <DeleteBar>
            <DeleteButton onClick={() => handleDeleteProject(activeProjectId)}>
              <span>🗑</span> Delete Project
            </DeleteButton>
          </DeleteBar>
        )}
        <AnimatePresence>
          {snoozePickerTaskId && (() => {
            const snoozeTask = tasks.find(t => t.id === snoozePickerTaskId);
            return snoozeTask ? (
              <SnoozePicker
              task={snoozeTask}
              settings={settings}
              onSnooze={(snoozeUntil, reminder) => {
                const updated = toPlainTask(snoozeTask);
                updated.snoozeUntil = snoozeUntil;
                updated.reminder = reminder;
                updated.updated = Date.now();
                handleSaveTask(updated);
                handleSnooze(snoozeUntil, reminder, snoozeTask.id, snoozeTask.name);
              }}
              onClose={() => setSnoozePickerTaskId(null)}
            />
          ) : null;
        })()}
        </AnimatePresence>
        <AddButton
          $isEditing={editingTaskId !== null}
          $isAnimating={addButtonAnimating}
          hidden={fullscreenTaskId !== null || activeView === 'log' || activeView === 'upcoming'}
          onClick={() => editingTaskId === null && !addButtonAnimating && handleAddNewTask()}
          onTransitionEnd={handleAddButtonArrived}
        >
          <CirclePlus size="3.75rem" strokeWidth={1} color={colors.coral} />
        </AddButton>
      </>
    );
  }

  return (
    <>
      <AnimatePresence>
        {!appReady && (
          <LoadingScreen
            key="loading"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.4, ease: 'easeOut' }}
          >
            <motion.div
              animate={{ scale: [1, 1.3, 1], opacity: [0.5, 1, 0.5] }}
              transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
            >
              <RuneIcon size="4rem" />
            </motion.div>
          </LoadingScreen>
        )}
      </AnimatePresence>
      <AnimatePresence initial={false} custom={navDirection}>
        <Page
          key={pageKey}
          custom={navDirection}
          variants={slideVariants}
          initial="enter"
          animate="center"
          exit="exit"
          transition={pageTransition}
          onClick={pageKey === 'tasklist' ? handleCloseEditing : undefined}
          onDoubleClick={pageKey === 'tasklist' && import.meta.env.DEV ? handleRandomToast : undefined}
          {...(pageKey === 'tasklist' && import.meta.env.DEV ? doubleTapProps : {})}
        >
          {pageContent}
        </Page>
      </AnimatePresence>
      <Toast message={toast?.message} type={toast?.type} onDismiss={() => setToast(null)} />
    </>
  );
})

const LoadingScreen = styled(motion.div)`
  position: fixed;
  inset: 0;
  background: #242424;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
`;

const Page = styled(motion.div)`
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  padding: 0 0 1.25rem;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  background-color: #242424;
`;

const ContentWrapper = styled.div`
  width: 100%;
  max-width: 25rem;
  margin: 0 auto;
  box-sizing: border-box;
`;

const Header = styled.div`
  margin-bottom: 1.25rem;
`;

const TopRow = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  height: 3.25rem;
  padding: 0 0.5rem;
  opacity: ${props => props.$editing ? 0 : 1};
  transform: ${props => props.$editing ? 'translateY(-4rem)' : 'translateY(0)'};
  transition: opacity 0.3s ease, transform 0.3s ease;
  pointer-events: ${props => props.$editing ? 'none' : 'auto'};
`;

const Title = styled.h1`
  font-size: 2em;
  margin: 0.5rem 0 0;
  padding: 0 1.25rem;
`;

const MenuButton = styled.button`
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 0.5rem 0.5rem 0.5rem 0;
  display: flex;
  align-items: center;
`;

const BackButton = styled.button`
  background: none;
  border: none;
  color: #666;
  cursor: pointer;
  padding: 0.5rem 0;
  display: flex;
  align-items: center;
`;


const NavMenu = styled.div`
  padding: 0;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
`;

const NavScrollArea = styled.div`
  flex: 1;
  overflow-y: auto;
  min-height: 0;
`;

const NavFooter = styled.div`
  flex-shrink: 0;
`;

const NavItem = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 1.75rem;
  color: ${props => props.disabled ? '#555' : 'white'};
  font-size: 1rem;
  font-weight: ${props => props.$active ? '600' : '400'};
  cursor: ${props => props.disabled ? 'default' : 'pointer'};
  opacity: ${props => props.disabled ? 0.4 : 1};

  &:hover {
    ${props => !props.disabled && 'opacity: 0.8;'}
  }
`;

const NavIcon = styled.span`
  font-size: 1.125rem;
  margin-right: 0.75rem;
`;

const NavAddButton = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 1.75rem;
  color: #666;
  font-size: 1rem;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
`;

const NewProjectInput = styled.input`
  flex: 1;
  background: transparent;
  border: none;
  color: white;
  font-size: 1rem;
  outline: none;

  &::placeholder {
    color: #666;
  }
`;

const NavDivider = styled.div`
  height: 1px;
  background: #333;
  margin: 0.5rem 1rem;
`;

const NavSettingsItem = styled.div`
  padding: 0.75rem 1rem;
  color: #888;
  font-size: 0.9375rem;
  cursor: pointer;
  text-align: center;

  &:hover {
    opacity: 0.8;
  }
`;

const TaskListContainer = styled.ul`
  list-style: none;
  padding: 0 1.25rem;
`;

const DateGroupHeader = styled.div`
  color: #888;
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.03rem;
  padding: 1rem 0 0.25rem;
`;

const LoadMore = styled.button`
  display: block;
  margin: 1rem auto;
  padding: 0.5rem 1.5rem;
  background: transparent;
  border: 1px solid #444;
  border-radius: 1rem;
  color: #888;
  font-size: 0.8125rem;
  cursor: pointer;
`;

const DeleteBar = styled.div`
  position: fixed;
  bottom: 1.5rem;
  left: 50%;
  transform: translateX(-50%);
  background: #3a3a3c;
  border-radius: 1.25rem;
  padding: 0.5rem 0.75rem;
  display: flex;
  gap: 0.5rem;
  z-index: 250;
  box-shadow: 0 0.25rem 0.75rem rgba(0, 0, 0, 0.4);
`;

const DeleteButton = styled.button`
  background: none;
  border: none;
  color: #ccc;
  font-size: 0.9375rem;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.375rem;
  padding: 0.375rem 0.75rem;

  &:hover {
    color: white;
  }
`;

const ProxyInput = styled.input`
  position: fixed;
  opacity: 0;
  pointer-events: none;
  width: 0;
  height: 0;
  top: -100px;
`;

const AddButton = styled.button`
  position: fixed;
  height: 3.75rem;
  width: 3.75rem;
  min-width: 3.75rem;
  min-height: 3.75rem;
  padding: 0;
  border-radius: 50%;
  background: transparent;
  color: white;
  border: none;
  cursor: pointer;
  display: ${props => props.hidden ? 'none' : 'flex'};
  justify-content: center;
  align-items: center;
  z-index: 100;

  transition: ${props => props.$isAnimating === 'snap-down' ? 'none' : `opacity 0.3s ease, bottom 0.3s ease${props.$isAnimating && props.$isAnimating !== 'none' ? ', right 0.3s ease, transform 0.3s ease' : ''}`};

  bottom: ${props => props.$isAnimating === 'up' ? 'calc(100% - 11.25rem)' : (props.$isEditing || props.$isAnimating === 'snap-down') ? '-4rem' : '1.25rem'};
  right: ${props => props.$isAnimating === 'up' ? 'calc(50% - 1.875rem)' : '1.25rem'};
  transform: ${props => props.$isAnimating === 'up' ? 'scale(0.8)' : 'scale(1)'};
  opacity: ${props => (props.$isEditing || props.$isAnimating === 'snap-down') ? 0 : 1};
  pointer-events: ${props => (props.$isEditing || props.$isAnimating) ? 'none' : 'auto'};
`;


