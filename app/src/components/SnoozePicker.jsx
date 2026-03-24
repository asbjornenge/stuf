import React, { useState } from 'react';
import styled from 'styled-components';
import { motion } from 'framer-motion';
import RuneIcon from './RuneIcon';
import { CircleX, CircleCheckBig, Moon, Check as CheckIcon, Shell, Bell } from 'lucide-react';
import { colors } from '../theme';
import { isSyncing } from '../utils/sync';

function getMonthDays(year, month) {
  const first = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0).getDate();
  const startDow = (first.getDay() + 6) % 7; // Monday = 0
  return { lastDay, startDow };
}

function isSameDay(d1, d2) {
  return d1.getFullYear() === d2.getFullYear() &&
    d1.getMonth() === d2.getMonth() &&
    d1.getDate() === d2.getDate();
}

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export default function SnoozePicker({ task, settings, onSnooze, onClose }) {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const [viewMonth, setViewMonth] = useState(now.getMonth());
  const [viewYear, setViewYear] = useState(now.getFullYear());
  const [showReminder, setShowReminder] = useState(!!task.reminder);
  const [pendingSnooze, setPendingSnooze] = useState(task.snoozeUntil || null);
  const [pendingReminder, setPendingReminder] = useState(task.reminder || null);

  const hasChanged = pendingSnooze !== (task.snoozeUntil || null) || pendingReminder !== (task.reminder || null);
  const [reminderValue, setReminderValue] = useState(() => {
    if (task.reminder) {
      const d = new Date(task.reminder);
      return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    }
    const n = new Date();
    return `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`;
  });

  const snoozeDate = pendingSnooze ? new Date(pendingSnooze) : null;
  const isToday = !snoozeDate || snoozeDate <= now;

  const eveningHour = settings?.eveningHour ?? 17;
  const eveningTime = new Date(today);
  eveningTime.setHours(eveningHour, 0, 0, 0);
  const isPastEvening = eveningTime <= now;

  const isThisEvening = !isPastEvening && snoozeDate && isSameDay(snoozeDate, eveningTime) &&
    snoozeDate.getHours() === eveningHour;

  const computeReminder = (snoozeUntil) => {
    if (!showReminder || !reminderValue) return null;
    const [h, m] = reminderValue.split(':').map(Number);
    const baseDate = snoozeUntil ? new Date(snoozeUntil) : new Date();
    const reminderDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), h, m, 0, 0);
    return reminderDate.getTime();
  };

  const handleSelect = (snoozeUntil) => {
    setPendingSnooze(snoozeUntil);
    setPendingReminder(computeReminder(snoozeUntil));
  };

  const handleSave = () => {
    onSnooze(pendingSnooze, pendingReminder);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  const handleDateClick = (day) => {
    const d = new Date(viewYear, viewMonth, day, settings?.morningHour ?? 9, 0, 0, 0);
    handleSelect(d.getTime());
  };

  const handleSomeday = () => {
    const min = settings?.somedayMinDays ?? 10;
    const max = settings?.somedayMaxDays ?? 60;
    const days = min + Math.floor(Math.random() * (max - min + 1));
    const d = new Date(today.getTime() + days * 86400000);
    d.setHours(settings?.morningHour ?? 9, 0, 0, 0);
    handleSelect(d.getTime());
    setViewMonth(d.getMonth());
    setViewYear(d.getFullYear());
  };

  const handleClear = () => {
    setPendingSnooze(null);
    setPendingReminder(null);
    setShowReminder(false);
    const n = new Date();
    setReminderValue(`${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}`);
  };

  const handleReminderChange = (value) => {
    setReminderValue(value);
    const [h, m] = value.split(':').map(Number);
    const baseDate = pendingSnooze ? new Date(pendingSnooze) : new Date();
    const reminderDate = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate(), h, m, 0, 0);
    setPendingReminder(reminderDate.getTime());
  };

  const prevMonth = () => {
    if (viewMonth === 0) {
      setViewMonth(11);
      setViewYear(viewYear - 1);
    } else {
      setViewMonth(viewMonth - 1);
    }
  };

  const nextMonth = () => {
    if (viewMonth === 11) {
      setViewMonth(0);
      setViewYear(viewYear + 1);
    } else {
      setViewMonth(viewMonth + 1);
    }
  };

  const { lastDay, startDow } = getMonthDays(viewYear, viewMonth);
  const calendarCells = [];
  for (let i = 0; i < startDow; i++) {
    calendarCells.push(null);
  }
  for (let d = 1; d <= lastDay; d++) {
    calendarCells.push(d);
  }

  const isCurrentMonth = viewYear === now.getFullYear() && viewMonth === now.getMonth();

  return (
    <Overlay onClick={handleClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <Modal onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.15 }}>
        <Header>
          <Title>When?</Title>
          <CloseButton onClick={hasChanged ? handleSave : handleClose} $changed={hasChanged}>
            {hasChanged ? <CircleCheckBig size="1.5rem" /> : <CircleX size="1.5rem" />}
          </CloseButton>
        </Header>

        <List>
          <Item onClick={() => handleSelect(null)}>
            <ItemIcon><RuneIcon /></ItemIcon>
            <ItemLabel>Today</ItemLabel>
            {isToday && <Check><CheckIcon size="1rem" color={colors.coral} /></Check>}
          </Item>

          {!isPastEvening && (
            <Item onClick={() => handleSelect(eveningTime.getTime())}>
              <ItemIcon><Moon size="1.125rem" color="#F5C030" /></ItemIcon>
              <ItemLabel>This Evening</ItemLabel>
              {isThisEvening && <Check><CheckIcon size="1rem" color={colors.coral} /></Check>}
            </Item>
          )}
        </List>

        <CalendarSection>
          <CalendarHeader>
            <CalendarNav onClick={prevMonth}>‹</CalendarNav>
            <CalendarTitle>{MONTH_NAMES[viewMonth]} {viewYear}</CalendarTitle>
            <CalendarNav onClick={nextMonth}>›</CalendarNav>
          </CalendarHeader>
          <DayHeaders>
            {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
              <DayHeader key={d}>{d}</DayHeader>
            ))}
          </DayHeaders>
          <DayGrid>
            {calendarCells.map((day, i) => {
              if (day === null) return <DayCell key={`empty-${i}`} />;
              const cellDate = new Date(viewYear, viewMonth, day);
              const isPast = cellDate < today;
              const isSelected = snoozeDate && isSameDay(cellDate, snoozeDate);
              const isTodayCell = isSameDay(cellDate, today);
              return (
                <DayCell
                  key={day}
                  $isPast={isPast}
                  $isSelected={isSelected}
                  $isToday={isTodayCell}
                  onClick={() => !isPast && handleDateClick(day)}
                >
                  {isTodayCell && !isCurrentMonth ? `${MONTH_NAMES[viewMonth]} ${day}` : day}
                </DayCell>
              );
            })}
          </DayGrid>
        </CalendarSection>

        <List>
          <Item onClick={handleSomeday}>
            <ItemIcon><Shell size="1.125rem" /></ItemIcon>
            <ItemLabel>Someday</ItemLabel>
          </Item>

          {!showReminder && (
            <Item onClick={() => setShowReminder(true)}>
              <ItemIcon><Bell size="1.125rem" /></ItemIcon>
              <ItemLabel>Add Reminder</ItemLabel>
            </Item>
          )}
        </List>

        {showReminder && !isSyncing() && (
          <ReminderNotice>
            Reminders send push notifications to your device, but require a sync server to deliver them. Connect to a sync server first.
          </ReminderNotice>
        )}

        {showReminder && isSyncing() && (
          <ReminderSection>
            <ReminderInput
              type="time"
              value={reminderValue}
              onChange={(e) => handleReminderChange(e.target.value)}
            />
          </ReminderSection>
        )}

        {(task.snoozeUntil || task.reminder) && (pendingSnooze || pendingReminder) && (
          <ClearButton onClick={handleClear}>Clear</ClearButton>
        )}
      </Modal>
    </Overlay>
  );
}

const Overlay = styled(motion.div)`
  position: fixed;
  inset: 0;
  z-index: 300;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.5);
`;

const Modal = styled(motion.div)`
  background: #3a3a3c;
  border-radius: 0.75rem;
  width: 18.75rem;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  overflow-x: hidden;
  overflow-y: auto;
  padding-bottom: 0.5rem;
`;

const Header = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 1rem 1.25rem;
`;

const Title = styled.div`
  font-size: 1rem;
  font-weight: 600;
  color: white;
  flex: 1;
  text-align: center;
`;

const CloseButton = styled.button`
  background: none;
  border: none;
  color: ${p => p.$changed ? '#007AFF' : '#888'};
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;

  &:hover {
    color: white;
  }
`;

const List = styled.div`
  padding: 0 1.25rem;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  padding: 0.4rem 0;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
`;

const ItemIcon = styled.span`
  font-size: 1.125rem;
  margin-right: 0.75rem;
  display: flex;
  align-items: center;
`;

const ItemLabel = styled.span`
  flex: 1;
  color: white;
  font-size: 1rem;
`;

const Check = styled.span`
  display: flex;
  align-items: center;
`;

const CalendarSection = styled.div`
  padding: 0.25rem 1rem 0.5rem;
`;

const CalendarHeader = styled.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.25rem;
`;

const CalendarTitle = styled.span`
  color: #ccc;
  font-size: 0.875rem;
  font-weight: 500;
`;

const CalendarNav = styled.button`
  background: none;
  border: none;
  color: #888;
  font-size: 1.375rem;
  cursor: pointer;
  padding: 0.25rem 0.5rem;

  &:hover {
    color: white;
  }
`;

const DayHeaders = styled.div`
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  margin-bottom: 0.125rem;
`;

const DayHeader = styled.div`
  color: #888;
  font-size: 0.6875rem;
  text-align: center;
  padding: 0.125rem 0;
`;

const DayGrid = styled.div`
  display: grid;
  grid-template-columns: repeat(7, 1fr);
  gap: 0.125rem;
`;

const DayCell = styled.div`
  text-align: center;
  padding: 0.3rem 0;
  font-size: 0.875rem;
  border-radius: 0.5rem;
  cursor: ${props => props.$isPast ? 'default' : 'pointer'};
  color: ${props => {
    if (props.$isPast) return '#555';
    if (props.$isSelected) return 'white';
    if (props.$isToday) return '#00D8FF';
    return '#ccc';
  }};
  background: ${props => props.$isSelected ? '#00D8FF33' : 'transparent'};
  font-weight: ${props => props.$isToday ? '600' : '400'};

  &:hover {
    ${props => !props.$isPast && !props.$isSelected && 'background: #ffffff11;'}
  }
`;

const ReminderSection = styled.div`
  padding: 0 1.25rem 0.75rem;
`;

const ReminderNotice = styled.div`
  padding: 0.75rem 1.25rem;
  color: #999;
  font-size: 0.8125rem;
  line-height: 1.4;
`;

const ReminderInput = styled.input`
  max-width: 100%;
  width: 100%;
  background: #2a2a2c;
  border: 1px solid #555;
  border-radius: 0.5rem;
  color: white;
  font-size: 1rem;
  padding: 0.625rem;
  outline: none;
  box-sizing: border-box;
  -webkit-appearance: none;
  appearance: none;
`;

const ClearButton = styled.button`
  margin: 0.5rem 1.25rem 1rem;
  background: #ff375f;
  border: none;
  color: white;
  font-size: 0.9375rem;
  font-weight: 500;
  padding: 0.75rem;
  border-radius: 0.5rem;
  cursor: pointer;

  &:hover {
    opacity: 0.9;
  }
`;
