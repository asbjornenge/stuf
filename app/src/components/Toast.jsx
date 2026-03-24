import React from 'react';
import styled from 'styled-components';
import { AnimatePresence, motion } from 'framer-motion';
import { CheckCircle, AlertCircle, X } from 'lucide-react';

const springTransition = { type: 'spring', damping: 25, stiffness: 300 };

export default function Toast({ message, type = 'error', onDismiss }) {
  return (
    <AnimatePresence>
      {message && (
        <Wrapper
          initial={{ y: -80, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -80, opacity: 0 }}
          transition={springTransition}
        >
          <Container $type={type}>
            <Icon $type={type}>
              {type === 'success'
                ? <CheckCircle size="1rem" />
                : <AlertCircle size="1rem" />
              }
            </Icon>
            <Message>{message}</Message>
            <CloseButton onClick={onDismiss}>
              <X size="0.875rem" />
            </CloseButton>
          </Container>
        </Wrapper>
      )}
    </AnimatePresence>
  );
}

const Wrapper = styled(motion.div)`
  position: fixed;
  top: calc(1rem + env(safe-area-inset-top));
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  z-index: 9999;
  pointer-events: none;
`;

const Container = styled.div`
  background: ${props => props.$type === 'success' ? '#1a3a1f' : '#3a1a1a'};
  border: 1px solid ${props => props.$type === 'success' ? '#4cd964' : '#ff453a'};
  color: white;
  font-size: 0.875rem;
  padding: 0.625rem 0.75rem;
  border-radius: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 16rem;
  max-width: calc(100vw - 2rem);
  box-shadow: 0 0.25rem 1rem rgba(0, 0, 0, 0.4);
  pointer-events: auto;
`;

const Icon = styled.span`
  color: ${props => props.$type === 'success' ? '#4cd964' : '#ff453a'};
  display: inline-flex;
  flex-shrink: 0;
`;

const Message = styled.span`
  flex: 1;
`;

const CloseButton = styled.button`
  background: none;
  border: none;
  outline: none;
  color: #888;
  cursor: pointer;
  padding: 0.125rem;
  display: inline-flex;
  flex-shrink: 0;

  &:hover {
    color: white;
  }
`;
