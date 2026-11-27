// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	k, err := KonfigLesen()
	if err != nil {
		log.Fatalf("FATAL: %v", err)
	}
	l, err := Starten(k, &Protokoll{aus: os.Stdout})
	if err != nil {
		log.Fatalf("FATAL: %v", err)
	}
	defer l.Stoppen()
	fmt.Fprintf(os.Stderr, "adb-zentrale: WireGuard UDP %d, Tunnelnetz %s, Steuerung %s\n", k.WgPort, k.Netz, k.SteuerBind)
	sig := make(chan os.Signal, 1)
	signal.Notify(sig, syscall.SIGINT, syscall.SIGTERM)
	<-sig
}

// Laufend: Zentrale samt Steuerung und Takt; fuer main und die Tests.
type Laufend struct {
	*Zentrale
	server *http.Server
	steuer net.Listener
	stop   chan struct{}
}

func (l *Laufend) SteuerAdresse() string { return l.steuer.Addr().String() }

func (l *Laufend) Stoppen() {
	close(l.stop)
	l.server.Close()
	l.Schliessen()
}

// PeersAbgleichen holt die Liste von der pbx-api. Scheitert das, bleibt die
// bisherige: ein Ausfall von CT 220 soll keine Telefone abhaengen.
func (z *Zentrale) PeersAbgleichen() error {
	liste, err := z.anlage.Peers()
	if err != nil {
		return err
	}
	return z.PeersSetzen(liste, "abgleich")
}

func Starten(k Konfig, log *Protokoll) (*Laufend, error) {
	anlage := NeueAnlage(k, log)
	z, err := NeueZentrale(k, log, anlage)
	if err != nil {
		return nil, err
	}
	steuer, err := net.Listen("tcp", k.SteuerBind)
	if err != nil {
		z.Schliessen()
		return nil, err
	}
	l := &Laufend{Zentrale: z, steuer: steuer, stop: make(chan struct{}),
		server: &http.Server{Handler: z.Steuerung(), ReadHeaderTimeout: 10 * time.Second}}
	go l.server.Serve(steuer)
	go func() {
		if err := z.PeersAbgleichen(); err != nil {
			log.Schreiben(Eintrag{Aktion: "abgleich", Ergebnis: "fehler", Grund: err.Error()})
		}
		takt := time.NewTicker(30 * time.Second)
		defer takt.Stop()
		n := 0
		for {
			select {
			case <-takt.C:
				z.Aufraeumen()
				if n++; n%10 == 0 { // alle 5 Minuten
					if err := z.PeersAbgleichen(); err != nil {
						log.Schreiben(Eintrag{Aktion: "abgleich", Ergebnis: "fehler", Grund: err.Error()})
					}
				}
			case <-l.stop:
				return
			}
		}
	}()
	return l, nil
}
