import React from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles/index.css'

const el = document.getElementById('root')
if (!el) throw new Error('找不到根节点')

createRoot(el).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
