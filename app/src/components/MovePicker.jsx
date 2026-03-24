import React from 'react';
import styled from 'styled-components';
import { motion } from 'framer-motion';
import RuneIcon from './RuneIcon';
import { CircleX, Check as CheckIcon } from 'lucide-react';
import { colors } from '../theme';

export default function MovePicker({
  projects,
  currentProjectId,
  onMove,
  onClose,
}) {
  return (
    <Overlay onClick={onClose} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
      <Modal onClick={(e) => e.stopPropagation()} initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} transition={{ duration: 0.15 }}>
        <Header>
          <Title>Move to</Title>
          <CloseButton onClick={onClose}><CircleX size="1.5rem" /></CloseButton>
        </Header>
        <List>
          <Item onClick={() => { onMove(null); onClose(); }}>
            <ItemIcon><RuneIcon /></ItemIcon>
            <ItemLabel>stꝋf</ItemLabel>
            {!currentProjectId && <Check><CheckIcon size="1rem" color={colors.coral} /></Check>}
          </Item>
          {(projects || []).map(project => (
            <Item
              key={project.id}
              onClick={() => { onMove(project.id); onClose(); }}
            >
              <ItemIcon>○</ItemIcon>
              <ItemLabel>{project.name}</ItemLabel>
              {currentProjectId === project.id && <Check><CheckIcon size="1rem" color={colors.coral} /></Check>}
            </Item>
          ))}
        </List>
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
  max-height: 60vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
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
  color: #888;
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
  overflow-y: auto;
  padding: 0 1.25rem 1rem;
`;

const Item = styled.div`
  display: flex;
  align-items: center;
  padding: 0.75rem 0;
  cursor: pointer;

  &:hover {
    opacity: 0.8;
  }
`;

const ItemIcon = styled.span`
  font-size: 1.125rem;
  margin-right: 0.75rem;
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
