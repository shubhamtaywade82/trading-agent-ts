Rails.application.routes.draw do
  root "pages#home"

  resources :users, only: %i[index show create] do
    member do
      post :activate
    end
    resources :orders, only: [:index]
  end

  namespace :admin do
    resources :reports, only: [:index]
  end

  get "health", to: "system#health"
end
