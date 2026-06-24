import React from 'react'
import ReactDOM from 'react-dom/client'
import BetBoard from './App.jsx'
import AuthGate from './AuthGate.jsx'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate>
      <BetBoard />
    </AuthGate>
  </React.StrictMode>
)
